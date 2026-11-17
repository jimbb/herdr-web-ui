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
import type { AgentStatus } from "../shared/protocol.ts";
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
import {
  countCoreWorkingTerminals,
  deliverQueuePrompt,
  getCoreTerminals,
  openQueueTab,
  type DeliverQueuePromptDeps,
  type OpenQueueTabDeps,
} from "./herdr-core/queue-helpers.ts";
import { shownStatusOf, type HcTerminal } from "./herdr-core/snapshot.ts";

export const QUEUE_POLL_INTERVAL_MS = 30_000;

export interface AgentQueueServiceOptions {
  store?: AgentQueueStore;
  stateDir?: string;
  getPreferences: () => SharedPreferences;
  openTab?: (folder: string, title?: string | null, deps?: OpenQueueTabDeps) => Promise<string>;
  launchAgent?: typeof agentLaunch;
  deliverPrompt?: (paneId: string, text: string, deps?: DeliverQueuePromptDeps) => Promise<void>;
  forgetLaunchedAgent?: (paneId: string) => void;
  getTerminals?: () => Promise<HcTerminal[]>;
  readMemAvailableMb?: () => number | null;
  resolveReal?: (path: string) => string;
  now?: () => number;
  pollIntervalMs?: number;
}

interface DeliveryState {
  sent: boolean;
  latestStatus?: AgentStatus;
}

/**
 * Per-project agent task queue dispatcher and status tracker for the local `herdr-core` runtime.
 * Serializes launches through a mutex, triggers at most one launch per tick when all gates pass,
 * and broadcasts normalized `QueueSnapshot` updates to subscribers.
 */
export class AgentQueueService {
  readonly store: AgentQueueStore;
  private readonly getPreferences: () => SharedPreferences;
  private readonly openTab: (folder: string, title?: string | null, deps?: OpenQueueTabDeps) => Promise<string>;
  private readonly launchAgentFn: typeof agentLaunch;
  private readonly deliverPrompt: (paneId: string, text: string, deps?: DeliverQueuePromptDeps) => Promise<void>;
  private readonly forgetLaunchedAgent: (paneId: string) => void;
  private readonly getTerminals: () => Promise<HcTerminal[]>;
  private readonly readMemAvailableMb: () => number | null;
  private readonly resolveReal: ((path: string) => string) | undefined;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;

  private readonly listeners = new Set<(queue: QueueSnapshot) => void>();
  private readonly hasWorked = new Set<string>();
  private readonly deliveringPanes = new Map<string, DeliveryState>();
  private launchingTaskId: string | null = null;
  private mutex: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopStoreSub: (() => void) | null = null;
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
    this.deliverPrompt = options.deliverPrompt ?? ((paneId, text, deps) => deliverQueuePrompt(paneId, text, deps));
    this.forgetLaunchedAgent = options.forgetLaunchedAgent ?? ((paneId) => launchedAgents.forget(paneId));
    this.getTerminals = options.getTerminals ?? (() => getCoreTerminals());
    this.readMemAvailableMb = options.readMemAvailableMb ?? (() => readProcMemAvailableMb());
    this.resolveReal = options.resolveReal;
    this.pollIntervalMs = options.pollIntervalMs ?? QUEUE_POLL_INTERVAL_MS;
    this.lastMemAvailableMb = this.readMemAvailableMb();

    this.stopStoreSub = this.store.subscribe(() => {
      this.emitIfChanged();
    });
  }

  /** Starts the background 30s ticker and reconciles any persisted `running` tasks from prior runs. */
  start(): void {
    if (this.stopped) return;
    this.lastMemAvailableMb = this.readMemAvailableMb();
    if (this.timer === null) {
      this.timer = setInterval(() => {
        void this.tick().catch((error: unknown) => {
          console.error("agent-queue: tick failed:", error instanceof Error ? error.message : String(error));
        });
      }, this.pollIntervalMs);
      this.timer.unref?.();
    }
    void this.reconcile().catch(() => undefined);
  }

  /** Stops the background ticker and store listeners without closing or killing any terminals. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
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
        this.reconcileWithTerminals(terminals);
      }
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
        this.reconcileWithTerminals(terminals);
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
        this.reconcileWithTerminals(terminals);
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
    if (task.status !== "running") this.hasWorked.delete(task.id);
    const queue = this.cachedSnapshot();
    this.emitIfChanged(queue);
    return { task, queue };
  }

  deleteTask(id: string): { ok: true; queue: QueueSnapshot } {
    if (this.launchingTaskId === id) {
      throw new QueueConflictError("task_running", "Cannot delete a task while it is starting");
    }
    this.lastMemAvailableMb = this.readMemAvailableMb();
    this.store.deleteTask(id);
    this.hasWorked.delete(id);
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

  /** Receives live pane status updates from `server/core/status.ts`. */
  onPaneStatus(paneId: string, status: AgentStatus, _agent?: string | null, failedRest = false): void {
    if (this.stopped) return;
    const tasks = this.store.getDocument().tasks;
    for (const task of tasks) {
      if (task.status !== "running" || task.terminal !== paneId) continue;

      const delivery = this.deliveringPanes.get(paneId);
      if (delivery) {
        if (delivery.sent) {
          if (failedRest) {
            this.hasWorked.delete(task.id);
            delivery.latestStatus = status;
          } else {
            if (status === "working") this.hasWorked.add(task.id);
            delivery.latestStatus = status;
          }
        }
        continue;
      }

      if (failedRest) {
        this.hasWorked.delete(task.id);
        continue;
      }
      if (status === "working") {
        this.hasWorked.add(task.id);
      } else if (status === "done" || (status === "idle" && this.hasWorked.has(task.id))) {
        this.hasWorked.delete(task.id);
        this.store.markTaskDone(task.id);
      }
      // `blocked` and `unknown` leave the task `running` and preserve `hasWorked`.
    }
  }

  /** Receives pane exit / close notifications from `server/core/status.ts`. */
  onPaneGone(paneId: string, reason = "Terminal closed"): void {
    if (this.stopped) return;
    const tasks = this.store.getDocument().tasks;
    for (const task of tasks) {
      if (task.status !== "running" || task.terminal !== paneId) continue;
      this.hasWorked.delete(task.id);
      this.store.markTaskFailed(task.id, reason, paneId);
    }
  }

  /** Updates the recorded terminal ID if a pane is moved under a new ID. */
  onPaneMoved(from: string, to: string): void {
    if (this.stopped) return;
    const delivery = this.deliveringPanes.get(from);
    if (delivery) {
      this.deliveringPanes.delete(from);
      this.deliveringPanes.set(to, delivery);
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
    let deliveryEntry: DeliveryState | null = null;

    try {
      const preferences = this.getPreferences();
      const spec = launchSpecFromPreferences(task.agent, preferences.settings, task.prompt);
      if (!spec.agent) {
        return this.store.markTaskFailed(task.id, `Invalid agent kind: ${task.agent}`, null);
      }

      paneId = await this.openTab(task.folder, task.title);
      this.store.markTaskRunning(task.id, paneId);

      if (spec.prompt?.via === "pending") {
        deliveryEntry = { sent: false };
        this.deliveringPanes.set(paneId, deliveryEntry);
      }

      const launched = await this.launchAgentFn(paneId, spec.agent);
      if (!launched.agent_started) {
        const message = launched.error.message || "Agent launch failed";
        return this.markFailedIfStillRunning(task.id, message, paneId);
      }

      if (spec.prompt?.via === "positional") {
        this.forgetLaunchedAgent(paneId);
      } else if (spec.prompt?.via === "pending" && deliveryEntry !== null) {
        const currentPane = () => this.currentTaskTerminal(task.id) ?? paneId!;
        await this.deliverPrompt(currentPane(), spec.prompt.text, {
          beforeSend: () => {
            const activePane = currentPane();
            this.forgetLaunchedAgent(activePane);
            this.hasWorked.delete(task.id);
            deliveryEntry!.sent = true;
            deliveryEntry!.latestStatus = undefined;
          },
          onRetry: () => {
            deliveryEntry!.sent = false;
          },
        });
        const settledPane = currentPane();
        this.deliveringPanes.delete(paneId);
        this.deliveringPanes.delete(settledPane);
        deliveryEntry.sent = false;

        const stored = this.getStoredTask(task.id);
        if (stored && stored.status === "running") {
          if (deliveryEntry.latestStatus === "done" || (deliveryEntry.latestStatus === "idle" && this.hasWorked.has(task.id))) {
            this.hasWorked.delete(task.id);
            return this.store.markTaskDone(task.id);
          }
        }
      }

      return this.getStoredTask(task.id) ?? this.store.markTaskRunning(task.id, paneId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return this.markFailedIfStillRunning(task.id, reason || "Task launch failed", paneId);
    } finally {
      if (paneId !== null) this.deliveringPanes.delete(paneId);
      const currentPane = this.currentTaskTerminal(task.id);
      if (currentPane) this.deliveringPanes.delete(currentPane);
      this.launchingTaskId = null;
    }
  }

  private reconcileWithTerminals(terminals: readonly HcTerminal[]): void {
    const byAddress = new Map<string, HcTerminal>();
    for (const terminal of terminals) {
      byAddress.set(terminal.address, terminal);
    }

    for (const task of this.store.getDocument().tasks) {
      if (task.status !== "running") continue;
      if (task.id === this.launchingTaskId) continue;

      if (!task.terminal) {
        this.hasWorked.delete(task.id);
        this.store.markTaskFailed(task.id, "No terminal associated with running task", null);
        continue;
      }

      const terminal = byAddress.get(task.terminal);
      if (!terminal) {
        this.hasWorked.delete(task.id);
        this.store.markTaskFailed(task.id, "Terminal closed", task.terminal);
        continue;
      }
      if (terminal.state !== "live") {
        this.hasWorked.delete(task.id);
        this.store.markTaskFailed(task.id, "Terminal ended", task.terminal);
        continue;
      }

      const shown = shownStatusOf(terminal.status, terminal.turn, terminal.labels);
      if (shown === "working") {
        this.hasWorked.add(task.id);
      } else if (shown === "done" || (shown === "idle" && this.hasWorked.has(task.id))) {
        if (!this.deliveringPanes.has(task.terminal)) {
          this.hasWorked.delete(task.id);
          this.store.markTaskDone(task.id);
        }
      }
    }
  }

  private markFailedIfStillRunning(id: string, reason: string, fallbackPaneId: string | null): QueueTask {
    const current = this.getStoredTask(id);
    if (current && current.status !== "running" && current.status !== "queued") {
      return current;
    }
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
