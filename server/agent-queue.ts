import {
  DEFAULT_QUEUE_AGENT,
  type QueueCreateTaskRequest,
  type QueueReorderRequest,
  type QueueSettings,
  type QueueSnapshot,
  type QueueTask,
  type QueueUpdateSettingsRequest,
  type QueueUpdateTaskRequest,
} from "../shared/agent-queue.ts";
import { launchSpecFromPreferences } from "../shared/agent-launch.ts";
import type { SharedPreferences } from "../shared/preferences.ts";
import type { AgentStatus, PendingMessage } from "../shared/protocol.ts";
import { agentLaunch } from "./agent-launch.ts";
import {
  AgentQueueStore,
  canonicalProjectKey,
  evaluateQueueGate,
  pickNextQueueTask,
  QueueConflictError,
  QueueNotFoundError,
  type QueueMetrics,
  readProcMemAvailableMb,
} from "./agent-queue-store.ts";
import { launchedAgents } from "./launched-agents.ts";
import type { QueueFirstMessageHooks } from "./pending-input.ts";
import {
  countCoreWorkingTerminals,
  getCoreTerminals,
  isQueuePaneAgentExited,
  isQueuePaneDialogBlocked,
  openQueueTab,
  type OpenQueueTabDeps,
} from "./herdr-core/queue-helpers.ts";
import { shownStatusOf, type HcTerminal } from "./herdr-core/snapshot.ts";

export const QUEUE_POLL_INTERVAL_MS = 30_000;
export const QUEUE_MONITOR_INTERVAL_MS = 2_000;

export interface AgentQueueServiceOptions {
  store?: AgentQueueStore;
  stateDir?: string;
  getPreferences: () => SharedPreferences;
  openTab?: (folder: string, title?: string | null, deps?: OpenQueueTabDeps) => Promise<string>;
  launchAgent?: typeof agentLaunch;
  enqueuePrompt?: (
    paneId: string,
    text: string,
    kind: string,
    hooks: QueueFirstMessageHooks,
    launchedPid?: number | null,
  ) => Promise<PendingMessage>;
  cancelPrompt?: (paneId: string) => void;
  forgetLaunchedAgent?: (paneId: string) => void;
  getTerminals?: () => Promise<HcTerminal[]>;
  checkAgentExited?: (terminal: HcTerminal, expectedAgent: string) => Promise<boolean>;
  checkDialogBlocked?: (terminal: HcTerminal, expectedAgent?: string | null) => Promise<boolean>;
  readMemAvailableMb?: () => number | null;
  resolveReal?: (path: string) => string;
  now?: () => number;
  pollIntervalMs?: number;
  monitorIntervalMs?: number;
}

interface DeliveryState {
  paneId: string;
  blocked: boolean;
}

/**
 * Per-project agent task queue dispatcher and status tracker for the local `herdr-core` runtime.
 * Serializes launches through a mutex, triggers at most one launch per tick when all gates pass,
 * delivers pending first prompts through Ovis's guarded pending pipeline, monitors running panes for
 * dialogs or agent exit, and broadcasts normalized `QueueSnapshot` updates to subscribers.
 */
export class AgentQueueService {
  readonly store: AgentQueueStore;
  private readonly getPreferences: () => SharedPreferences;
  private readonly openTab: (folder: string, title?: string | null, deps?: OpenQueueTabDeps) => Promise<string>;
  private readonly launchAgentFn: typeof agentLaunch;
  private readonly enqueuePrompt: (
    paneId: string,
    text: string,
    kind: string,
    hooks: QueueFirstMessageHooks,
    launchedPid?: number | null,
  ) => Promise<PendingMessage>;
  private readonly cancelPrompt: (paneId: string) => void;
  private readonly forgetLaunchedAgent: (paneId: string) => void;
  private readonly getTerminals: () => Promise<HcTerminal[]>;
  private readonly checkAgentExited: (terminal: HcTerminal, expectedAgent: string) => Promise<boolean>;
  private readonly checkDialogBlocked: (terminal: HcTerminal, expectedAgent?: string | null) => Promise<boolean>;
  private readonly readMemAvailableMb: () => number | null;
  private readonly resolveReal: ((path: string) => string) | undefined;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly monitorIntervalMs: number;

  private readonly listeners = new Set<(queue: QueueSnapshot) => void>();
  private readonly hasWorked = new Set<string>();
  private readonly awaitingDelivery = new Map<string, DeliveryState>();
  private launchingTaskId: string | null = null;
  private mutex: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private monitorBusy = false;
  private stopStoreSub: (() => void) | null = null;
  private started = false;
  private stopped = false;

  private lastMemAvailableMb: number | null;
  private lastWorkingCount = 0;
  private lastEmittedJson: string | null = null;

  constructor(options: AgentQueueServiceOptions) {
    if (!options.store && !options.stateDir) {
      throw new Error("AgentQueueService requires store or stateDir");
    }
    this.now = options.now ?? (() => Date.now());
    this.store = options.store ?? new AgentQueueStore(options.stateDir!, { now: this.now });
    this.getPreferences = options.getPreferences;
    this.openTab = options.openTab ?? ((folder, title, deps) => openQueueTab(folder, title, deps));
    this.launchAgentFn = options.launchAgent ?? agentLaunch;
    this.enqueuePrompt = options.enqueuePrompt ?? (async () => {
      throw new Error("Queue prompt delivery is not configured");
    });
    this.cancelPrompt = options.cancelPrompt ?? (() => undefined);
    this.forgetLaunchedAgent = options.forgetLaunchedAgent ?? ((paneId) => launchedAgents.forget(paneId));
    this.getTerminals = options.getTerminals ?? (() => getCoreTerminals());
    // Tests injecting getTerminals without explicit process/screen probes default to offline-safe checks
    // rather than hitting the real herdr daemon socket.
    this.checkAgentExited = options.checkAgentExited ?? (
      options.getTerminals !== undefined
        ? (async () => false)
        : ((terminal, expectedAgent) => isQueuePaneAgentExited(terminal, expectedAgent))
    );
    this.checkDialogBlocked = options.checkDialogBlocked ?? (
      options.getTerminals !== undefined
        ? (async (terminal) => shownStatusOf(terminal.status, terminal.turn, terminal.labels) === "blocked")
        : ((terminal, expectedAgent) => isQueuePaneDialogBlocked(terminal, expectedAgent))
    );
    this.readMemAvailableMb = options.readMemAvailableMb ?? (() => readProcMemAvailableMb());
    this.resolveReal = options.resolveReal;
    this.pollIntervalMs = options.pollIntervalMs ?? QUEUE_POLL_INTERVAL_MS;
    this.monitorIntervalMs = options.monitorIntervalMs ?? QUEUE_MONITOR_INTERVAL_MS;
    this.lastMemAvailableMb = this.readMemAvailableMb();

    this.stopStoreSub = this.store.subscribe(() => {
      this.emitIfChanged();
    });
  }

  /** Starts the background ticker, running-task monitor, and initial reconciliation of persisted tasks. */
  start(): void {
    if (this.stopped) return;
    this.started = true;
    this.lastMemAvailableMb = this.readMemAvailableMb();
    if (this.timer === null) {
      this.timer = setInterval(() => {
        void this.tick().catch((error: unknown) => {
          console.error("agent-queue: tick failed:", error instanceof Error ? error.message : String(error));
        });
      }, this.pollIntervalMs);
      this.timer.unref?.();
    }
    this.syncMonitorTimer();
    void this.reconcile().catch(() => undefined);
  }

  /** Stops background timers and store listeners without closing terminals or erasing persisted task state. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.monitorTimer !== null) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    this.stopStoreSub?.();
    this.stopStoreSub = null;
  }

  subscribe(listener: (queue: QueueSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Synchronous snapshot built from cached gate metrics for stream connects and broadcasts. */
  cachedSnapshot(): QueueSnapshot {
    return this.buildSnapshot(this.currentMetrics());
  }

  /** Refreshes file changes, memory availability, and core working count before returning a snapshot. */
  async snapshot(): Promise<QueueSnapshot> {
    this.store.syncIfChanged(false);
    this.lastMemAvailableMb = this.readMemAvailableMb();
    const terminals = await this.safeGetTerminals();
    if (terminals !== null) {
      this.lastWorkingCount = countCoreWorkingTerminals(terminals);
    }
    const snap = this.cachedSnapshot();
    this.emitIfChanged(snap);
    return snap;
  }

  /** Reconciles running tasks with live core terminals without starting any new tasks. */
  async reconcile(): Promise<QueueSnapshot> {
    return this.withLaunchLock(async () => {
      if (this.stopped) return this.cachedSnapshot();
      this.store.syncIfChanged(false);
      this.lastMemAvailableMb = this.readMemAvailableMb();
      const terminals = await this.safeGetTerminals();
      if (terminals !== null) {
        this.lastWorkingCount = countCoreWorkingTerminals(terminals);
        await this.reconcileWithTerminals(terminals);
      }
      this.syncMonitorTimer();
      const snap = this.cachedSnapshot();
      this.emitIfChanged(snap);
      return snap;
    });
  }

  /** Reconciles running tasks and launches at most one eligible queued task if all gates pass. */
  async tick(): Promise<QueueSnapshot> {
    return this.withLaunchLock(async () => {
      if (this.stopped) return this.cachedSnapshot();
      this.store.syncIfChanged(false);
      this.lastMemAvailableMb = this.readMemAvailableMb();
      const terminals = await this.safeGetTerminals();
      if (terminals !== null) {
        this.lastWorkingCount = countCoreWorkingTerminals(terminals);
        await this.reconcileWithTerminals(terminals);
      }

      const metrics = this.currentMetrics();
      const doc = this.store.getDocument();
      const next = terminals === null ? null : pickNextQueueTask(doc, metrics, this.resolveReal);
      if (next) {
        await this.launchTask(next);
        this.lastMemAvailableMb = this.readMemAvailableMb();
        const updated = await this.safeGetTerminals();
        if (updated !== null) {
          this.lastWorkingCount = countCoreWorkingTerminals(updated);
        }
      }

      this.syncMonitorTimer();
      const snap = this.cachedSnapshot();
      this.emitIfChanged(snap);
      return snap;
    });
  }

  /**
   * Immediately starts a queued task, bypassing hold, global pause, memory, working-count, and cooldown gates
   * while still enforcing 1 running task per canonical project folder.
   */
  async startNow(id: string): Promise<{ task: QueueTask; queue: QueueSnapshot }> {
    return this.withLaunchLock(async () => {
      this.store.syncIfChanged(false);
      if (this.launchingTaskId === id) {
        throw new QueueConflictError("task_running", "Task is already starting");
      }
      const doc = this.store.getDocument();
      const existing = doc.tasks.find((task) => task.id === id);
      if (!existing) throw new QueueNotFoundError(id);
      if (existing.status !== "queued") {
        throw new QueueConflictError("task_not_queued", `Only queued tasks can be started (task is ${existing.status})`);
      }

      const terminals = await this.safeGetTerminals();
      if (terminals !== null) {
        this.lastWorkingCount = countCoreWorkingTerminals(terminals);
        await this.reconcileWithTerminals(terminals);
      }

      const projectKey = canonicalProjectKey(existing.folder, this.resolveReal);
      const runningSibling = this.store.getDocument().tasks.find(
        (task) => task.status === "running" && canonicalProjectKey(task.folder, this.resolveReal) === projectKey,
      );
      if (runningSibling) {
        throw new QueueConflictError("project_busy", `Project already has a running task: ${runningSibling.title}`);
      }

      const task = await this.launchTask(existing);
      this.lastMemAvailableMb = this.readMemAvailableMb();
      const after = await this.safeGetTerminals();
      if (after !== null) {
        this.lastWorkingCount = countCoreWorkingTerminals(after);
      }
      this.syncMonitorTimer();
      const queue = this.cachedSnapshot();
      this.emitIfChanged(queue);
      return { task, queue };
    });
  }

  createTask(input: QueueCreateTaskRequest): { task: QueueTask; queue: QueueSnapshot } {
    this.lastMemAvailableMb = this.readMemAvailableMb();
    const task = this.store.createTask({ ...input, agent: input.agent ?? DEFAULT_QUEUE_AGENT });
    const queue = this.cachedSnapshot();
    this.emitIfChanged(queue);
    return { task, queue };
  }

  updateTask(id: string, patch: QueueUpdateTaskRequest): { task: QueueTask; queue: QueueSnapshot } {
    if (this.launchingTaskId === id) {
      throw new QueueConflictError("task_running", "Cannot edit a task while it is starting");
    }
    this.lastMemAvailableMb = this.readMemAvailableMb();
    const task = this.store.updateTask(id, patch);
    if (task.status !== "running") {
      this.hasWorked.delete(task.id);
      if (this.awaitingDelivery.delete(task.id) && task.terminal) {
        this.cancelPrompt(task.terminal);
      }
      this.syncMonitorTimer();
    }
    const queue = this.cachedSnapshot();
    this.emitIfChanged(queue);
    return { task, queue };
  }

  deleteTask(id: string): { ok: true; queue: QueueSnapshot } {
    if (this.launchingTaskId === id) {
      throw new QueueConflictError("task_running", "Cannot delete a task while it is starting");
    }
    this.lastMemAvailableMb = this.readMemAvailableMb();
    const prev = this.getStoredTask(id);
    this.store.deleteTask(id);
    this.hasWorked.delete(id);
    if (this.awaitingDelivery.delete(id) && prev?.terminal) {
      this.cancelPrompt(prev.terminal);
    }
    this.syncMonitorTimer();
    const queue = this.cachedSnapshot();
    this.emitIfChanged(queue);
    return { ok: true, queue };
  }

  reorder(input: QueueReorderRequest): { tasks: QueueTask[]; queue: QueueSnapshot } {
    this.lastMemAvailableMb = this.readMemAvailableMb();
    const tasks = this.store.reorder(input, this.resolveReal);
    const queue = this.cachedSnapshot();
    this.emitIfChanged(queue);
    return { tasks, queue };
  }

  updateSettings(patch: QueueUpdateSettingsRequest): { settings: QueueSettings; queue: QueueSnapshot } {
    this.lastMemAvailableMb = this.readMemAvailableMb();
    const settings = this.store.updateSettings(patch);
    const queue = this.cachedSnapshot();
    this.emitIfChanged(queue);
    return { settings, queue };
  }

  /** Receives interactive prompt-answer notifications so dialog wait badges clear immediately. */
  onPanePromptAnswered(paneId: string): void {
    if (this.stopped) return;
    for (const task of this.store.getDocument().tasks) {
      if (task.status !== "running" || task.terminal !== paneId) continue;
      const entry = this.awaitingDelivery.get(task.id);
      if (entry) entry.blocked = false;
      this.store.setTaskNeedsInput(task.id, false);
    }
  }

  /** Receives live pane status updates from `server/core/status.ts`. */
  onPaneStatus(paneId: string, status: AgentStatus, _agent?: string | null, failedRest = false): void {
    if (this.stopped) return;
    const tasks = this.store.getDocument().tasks;
    for (const task of tasks) {
      if (task.status !== "running" || task.terminal !== paneId) continue;

      const delivery = this.awaitingDelivery.get(task.id);
      if (delivery) {
        if (status === "blocked") {
          this.store.setTaskNeedsInput(task.id, true);
        } else if (status === "working") {
          delivery.blocked = false;
          this.store.setTaskNeedsInput(task.id, false);
        } else if (!delivery.blocked && status === "idle") {
          this.store.setTaskNeedsInput(task.id, false);
        }
        continue;
      }

      if (failedRest) {
        this.hasWorked.delete(task.id);
        this.store.setTaskNeedsInput(task.id, false);
        continue;
      }
      if (status === "working") {
        this.hasWorked.add(task.id);
        this.store.setTaskNeedsInput(task.id, false);
      } else if (status === "blocked") {
        this.store.setTaskNeedsInput(task.id, true);
      } else if (status === "done" || (status === "idle" && this.hasWorked.has(task.id))) {
        this.hasWorked.delete(task.id);
        this.awaitingDelivery.delete(task.id);
        this.store.markTaskDone(task.id);
        this.syncMonitorTimer();
      } else if (status === "idle") {
        this.store.setTaskNeedsInput(task.id, false);
      }
      // `unknown` preserves current `needsInput` and `hasWorked` until screen/process probes run.
    }
  }

  /** Receives pane exit / close notifications from `server/core/status.ts`. */
  onPaneGone(paneId: string, reason = "Terminal closed"): void {
    if (this.stopped) return;
    this.cancelPrompt(paneId);
    const tasks = this.store.getDocument().tasks;
    for (const task of tasks) {
      if (task.status !== "running" || task.terminal !== paneId) continue;
      this.awaitingDelivery.delete(task.id);
      this.hasWorked.delete(task.id);
      this.store.markTaskFailed(task.id, reason, paneId);
    }
    this.syncMonitorTimer();
  }

  /** Updates the recorded terminal ID if a pane is moved under a new ID. */
  onPaneMoved(from: string, to: string): void {
    if (this.stopped) return;
    for (const entry of this.awaitingDelivery.values()) {
      if (entry.paneId === from) entry.paneId = to;
    }
    const tasks = this.store.getDocument().tasks;
    for (const task of tasks) {
      if (task.status !== "running" || task.terminal !== from) continue;
      this.store.setTaskTerminal(task.id, to);
    }
  }

  private async launchTask(task: QueueTask): Promise<QueueTask> {
    this.launchingTaskId = task.id;
    this.hasWorked.delete(task.id);
    let paneId: string | null = null;

    try {
      const preferences = this.getPreferences();
      const spec = launchSpecFromPreferences(task.agent, preferences.settings, task.prompt);
      if (!spec.agent) {
        return this.store.markTaskFailed(task.id, `Invalid agent kind: ${task.agent}`, null);
      }

      paneId = await this.openTab(task.folder, task.title);
      this.store.markTaskRunning(task.id, paneId);

      let launchedPid: number | null = null;
      const launched = await this.launchAgentFn(paneId, spec.agent, (pid) => {
        launchedPid = pid;
      });
      if (!launched.agent_started) {
        const message = launched.error.message || "Agent launch failed";
        return this.markFailedIfStillRunning(task.id, message, this.currentTaskTerminal(task.id) ?? paneId);
      }

      const activePane = this.currentTaskTerminal(task.id) ?? paneId;
      const afterLaunch = this.getStoredTask(task.id);
      if (!afterLaunch || afterLaunch.status !== "running") {
        return afterLaunch ?? this.markFailedIfStillRunning(task.id, "Terminal closed", activePane);
      }

      if (spec.prompt?.via === "positional") {
        this.forgetLaunchedAgent(activePane);
      } else if (spec.prompt?.via === "pending") {
        this.awaitingDelivery.set(task.id, { paneId: activePane, blocked: false });
        const hooks: QueueFirstMessageHooks = {
          onBlocked: (hookPaneId) => {
            if (this.stopped) return;
            const entry = this.awaitingDelivery.get(task.id);
            if (!entry) return;
            entry.paneId = hookPaneId;
            entry.blocked = true;
            this.store.setTaskNeedsInput(task.id, true);
          },
          onUnblocked: (hookPaneId) => {
            if (this.stopped) return;
            const entry = this.awaitingDelivery.get(task.id);
            if (!entry) return;
            entry.paneId = hookPaneId;
            entry.blocked = false;
            this.store.setTaskNeedsInput(task.id, false);
          },
          onBeforeCommit: (hookPaneId) => {
            if (this.stopped) return;
            this.awaitingDelivery.delete(task.id);
            this.hasWorked.delete(task.id);
            this.forgetLaunchedAgent(hookPaneId);
            this.store.setTaskNeedsInput(task.id, false);
          },
          onSent: (hookPaneId) => {
            if (this.stopped) return;
            if (this.awaitingDelivery.delete(task.id)) {
              this.hasWorked.delete(task.id);
              this.forgetLaunchedAgent(hookPaneId);
              this.store.setTaskNeedsInput(task.id, false);
            }
          },
          onFailed: (hookPaneId, reason) => {
            if (this.stopped) return;
            this.awaitingDelivery.delete(task.id);
            this.markFailedIfStillRunning(task.id, reason || "Prompt delivery failed", hookPaneId);
            this.syncMonitorTimer();
            if (this.started) {
              this.lastMemAvailableMb = this.readMemAvailableMb();
              const doc = this.store.getDocument();
              if (pickNextQueueTask(doc, this.currentMetrics(), this.resolveReal) !== null) {
                void this.tick().catch(() => undefined);
              }
            }
          },
        };

        try {
          await this.enqueuePrompt(activePane, spec.prompt.text, spec.agent.kind, hooks, launchedPid);
        } catch (error) {
          this.awaitingDelivery.delete(task.id);
          const reason = error instanceof Error ? error.message : String(error);
          return this.markFailedIfStillRunning(task.id, reason || "Prompt delivery failed", this.currentTaskTerminal(task.id) ?? activePane);
        }

        const afterEnqueue = this.getStoredTask(task.id);
        if (!afterEnqueue || afterEnqueue.status !== "running") {
          this.awaitingDelivery.delete(task.id);
          this.cancelPrompt(this.currentTaskTerminal(task.id) ?? activePane);
          return afterEnqueue ?? this.markFailedIfStillRunning(task.id, "Terminal closed", activePane);
        }
      }

      return this.getStoredTask(task.id) ?? this.store.markTaskRunning(task.id, activePane);
    } catch (error) {
      this.awaitingDelivery.delete(task.id);
      const reason = error instanceof Error ? error.message : String(error);
      return this.markFailedIfStillRunning(task.id, reason || "Task launch failed", this.currentTaskTerminal(task.id) ?? paneId);
    } finally {
      this.launchingTaskId = null;
      this.syncMonitorTimer();
    }
  }

  private async reconcileWithTerminals(terminals: readonly HcTerminal[]): Promise<void> {
    const byAddress = new Map<string, HcTerminal>();
    for (const terminal of terminals) {
      byAddress.set(terminal.address, terminal);
    }

    for (const task of this.store.getDocument().tasks) {
      if (task.status !== "running") continue;
      if (task.id === this.launchingTaskId) continue;

      if (!task.terminal) {
        this.awaitingDelivery.delete(task.id);
        this.hasWorked.delete(task.id);
        this.store.markTaskFailed(task.id, "No terminal associated with running task", null);
        continue;
      }

      const terminal = byAddress.get(task.terminal);
      if (!terminal) {
        this.cancelPrompt(task.terminal);
        this.awaitingDelivery.delete(task.id);
        this.hasWorked.delete(task.id);
        this.store.markTaskFailed(task.id, "Terminal closed", task.terminal);
        continue;
      }
      if (terminal.state !== "live") {
        this.cancelPrompt(task.terminal);
        this.awaitingDelivery.delete(task.id);
        this.hasWorked.delete(task.id);
        this.store.markTaskFailed(task.id, "Terminal ended", task.terminal);
        continue;
      }

      const shown = shownStatusOf(terminal.status, terminal.turn, terminal.labels);
      if (!this.awaitingDelivery.has(task.id)) {
        if (shown === "working") {
          this.hasWorked.add(task.id);
        } else if (shown === "done" || (shown === "idle" && this.hasWorked.has(task.id))) {
          this.hasWorked.delete(task.id);
          this.store.markTaskDone(task.id);
          continue;
        }
      }

      const exited = await this.checkAgentExited(terminal, task.agent).catch(() => false);
      if (this.stopped) return;
      const afterExitCheck = this.getStoredTask(task.id);
      if (!afterExitCheck || afterExitCheck.status !== "running" || afterExitCheck.terminal !== terminal.address) {
        continue;
      }
      if (exited) {
        this.cancelPrompt(terminal.address);
        this.awaitingDelivery.delete(task.id);
        this.hasWorked.delete(task.id);
        this.store.markTaskFailed(task.id, "Agent exited", terminal.address);
        continue;
      }

      const dialogBlocked = await this.checkDialogBlocked(terminal, task.agent).catch(() => false);
      if (this.stopped) return;
      const afterDialogCheck = this.getStoredTask(task.id);
      if (!afterDialogCheck || afterDialogCheck.status !== "running" || afterDialogCheck.terminal !== terminal.address) {
        continue;
      }
      const delivery = this.awaitingDelivery.get(task.id);
      this.store.setTaskNeedsInput(task.id, Boolean(delivery?.blocked || dialogBlocked));
    }
  }

  private syncMonitorTimer(): void {
    const hasRunning = !this.stopped && this.store.getDocument().tasks.some((task) => task.status === "running");
    if (!hasRunning) {
      if (this.monitorTimer !== null) {
        clearInterval(this.monitorTimer);
        this.monitorTimer = null;
      }
      return;
    }
    if (this.monitorTimer === null) {
      this.monitorTimer = setInterval(() => {
        void this.monitorTick().catch((error: unknown) => {
          console.error("agent-queue: monitor failed:", error instanceof Error ? error.message : String(error));
        });
      }, this.monitorIntervalMs);
      this.monitorTimer.unref?.();
    }
  }

  private async monitorTick(): Promise<void> {
    if (this.stopped || this.monitorBusy) return;
    this.monitorBusy = true;
    try {
      await this.withLaunchLock(async () => {
        if (this.stopped) return;
        this.store.syncIfChanged(false);
        this.lastMemAvailableMb = this.readMemAvailableMb();
        const beforeRunning = this.store.getDocument().tasks.filter((task) => task.status === "running").length;
        if (beforeRunning === 0) {
          this.syncMonitorTimer();
          return;
        }
        const terminals = await this.safeGetTerminals();
        if (terminals !== null) {
          this.lastWorkingCount = countCoreWorkingTerminals(terminals);
          await this.reconcileWithTerminals(terminals);
          const doc = this.store.getDocument();
          const afterRunning = doc.tasks.filter((task) => task.status === "running").length;
          if (this.started && afterRunning < beforeRunning) {
            const next = pickNextQueueTask(doc, this.currentMetrics(), this.resolveReal);
            if (next) {
              await this.launchTask(next);
              this.lastMemAvailableMb = this.readMemAvailableMb();
              const updated = await this.safeGetTerminals();
              if (updated !== null) {
                this.lastWorkingCount = countCoreWorkingTerminals(updated);
              }
            }
          }
        }
        this.syncMonitorTimer();
        const snap = this.cachedSnapshot();
        this.emitIfChanged(snap);
      });
    } finally {
      this.monitorBusy = false;
    }
  }

  private markFailedIfStillRunning(id: string, reason: string, fallbackPaneId: string | null): QueueTask {
    const current = this.getStoredTask(id);
    if (current && current.status !== "running" && current.status !== "queued") {
      return current;
    }
    this.awaitingDelivery.delete(id);
    this.hasWorked.delete(id);
    return this.store.markTaskFailed(id, reason, current?.terminal ?? fallbackPaneId);
  }

  private getStoredTask(id: string): QueueTask | null {
    return this.store.getDocument().tasks.find((task) => task.id === id) ?? null;
  }

  private currentTaskTerminal(id: string): string | null {
    return this.getStoredTask(id)?.terminal ?? null;
  }

  private currentMetrics(): QueueMetrics {
    return {
      memAvailableMb: this.lastMemAvailableMb,
      workingCount: this.lastWorkingCount,
      nowMs: this.now(),
    };
  }

  private buildSnapshot(metrics: QueueMetrics): QueueSnapshot {
    const doc = this.store.getDocument();
    return {
      version: doc.version,
      settings: doc.settings,
      lastLaunchAt: doc.lastLaunchAt,
      tasks: doc.tasks,
      gate: evaluateQueueGate(doc, metrics, { resolveReal: this.resolveReal }),
    };
  }

  private emitIfChanged(snapshot = this.cachedSnapshot()): void {
    const encoded = JSON.stringify(snapshot);
    if (encoded === this.lastEmittedJson) return;
    this.lastEmittedJson = encoded;
    for (const listener of [...this.listeners]) {
      listener(structuredClone(snapshot));
    }
  }

  private async safeGetTerminals(): Promise<HcTerminal[] | null> {
    try {
      return await this.getTerminals();
    } catch {
      return null;
    }
  }

  private withLaunchLock<T>(work: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(work, work);
    this.mutex = run.then(() => undefined, () => undefined);
    return run;
  }
}
