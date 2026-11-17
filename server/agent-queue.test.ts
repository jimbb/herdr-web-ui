import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineEvent } from "../shared/machines.ts";
import type { SharedPreferences } from "../shared/preferences.ts";
import type { SessionSnapshot } from "../shared/herdr-api.generated.ts";
import { MAX_LABEL_CHARS } from "../shared/labels.ts";
import { AgentQueueService } from "./agent-queue.ts";
import { QueueConflictError, QueueNotFoundError } from "./agent-queue-store.ts";
import { HerdrError } from "./herdr/client.ts";
import { HcError } from "./herdr-core/connection.ts";
import {
  countCoreWorkingTerminals,
  deliverQueuePrompt,
  openQueueTab,
  truncateTabLabel,
} from "./herdr-core/queue-helpers.ts";
import type { HcTerminal } from "./herdr-core/snapshot.ts";
import { subscribeMachineEvents } from "./machine-events.ts";

const tempDirs: string[] = [];
const EMPTY_PREFERENCES: SharedPreferences = { revision: 0, settings: {} };

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-queue-service-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTerminal(
  address: string,
  overrides: Partial<HcTerminal> = {},
): HcTerminal {
  return {
    address,
    cols: 120,
    rows: 40,
    cwd: "/srv/app",
    state: "live",
    turn: 0,
    labels: {},
    status: { state: "idle", app: "claude" },
    ...overrides,
  };
}

function emptySnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: [],
    agents: [],
    focused_pane_id: null,
    ...overrides,
  } as unknown as SessionSnapshot;
}

describe("queue-helpers", () => {
  it("truncates tab labels cleanly without splitting surrogate pairs", () => {
    expect(truncateTabLabel("  Hello\n\tWorld  ")).toBe("Hello World");
    const longEmoji = `${"a".repeat(MAX_LABEL_CHARS - 1)}😀tail`;
    const truncated = truncateTabLabel(longEmoji);
    expect(truncated.length).toBeLessThanOrEqual(MAX_LABEL_CHARS);
    expect(truncated).toBe("a".repeat(MAX_LABEL_CHARS - 1));
  });

  it("counts only live local working terminals", () => {
    const terminals: HcTerminal[] = [
      makeTerminal("t1", { status: { state: "working", app: "claude" } }),
      makeTerminal("t2", { status: { state: "idle", app: "codex" } }),
      makeTerminal("t3", { status: { state: "blocked", app: "claude" } }),
      makeTerminal("t4", { state: "ended", status: { state: "working", app: "claude" } }),
      makeTerminal("vps/t5", { status: { state: "working", app: "claude" } }),
      makeTerminal("t6", { status: { state: "working", app: "opencode" } }),
    ];
    expect(countCoreWorkingTerminals(terminals)).toBe(2);
  });

  it("opens tabs in matching active spaces, empty herdr-app spaces, snapshot workspaces, or a new workspace", async () => {
    // 1. Empty herdr-app space omitted from snapshot uses terminal.run with space labels
    const runCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const emptySpacePane = await openQueueTab("/repos/app-one/", "Fix login\nbug", {
      folderExists: () => true,
      terminalEnv: async () => ({ PATH: "/usr/bin" }),
      snapshot: async () => emptySnapshot(),
      hc: {
        async call(method: string, params: Record<string, unknown>) {
          runCalls.push({ method, params });
          if (method === "doc.get") {
            return { value: { spaces: [{ id: "sp-1", name: "App One", folder: "/repos/app-one" }] } } as never;
          }
          if (method === "terminal.run") {
            return { address: "t10" } as never;
          }
          throw new Error(`unexpected ${method}`);
        },
      },
    });
    expect(emptySpacePane).toBe("t10");
    const runCall = runCalls.find((call) => call.method === "terminal.run")!;
    expect(runCall.params["cwd"]).toBe("/repos/app-one/");
    expect(runCall.params["env"]).toEqual({ PATH: "/usr/bin" });
    expect(runCall.params["labels"]).toMatchObject({
      "herdr.seen": "0",
      "herdr.space": "sp-1",
      "ovis.workspace": "App One",
      "ovis.tab": "Fix login bug",
    });

    // 2. Active herdr-app space present in snapshot uses tabCreate
    const tabCalls: Array<{ workspaceId: string; cwd?: string; label?: string }> = [];
    const activeSpacePane = await openQueueTab("/repos/app-one", "Task Two", {
      folderExists: () => true,
      snapshot: async () => emptySnapshot({
        workspaces: [{ workspace_id: "sp-1", name: "App One", index: 0, focused_tab_id: null } as never],
      }),
      hc: {
        async call(method: string) {
          if (method === "doc.get") {
            return { value: { spaces: [{ id: "sp-1", name: "App One", folder: "/repos/app-one" }] } } as never;
          }
          throw new Error(`unexpected ${method}`);
        },
      },
      tabCreate: async (opts) => {
        tabCalls.push(opts);
        return { root_pane: { pane_id: "t11" } } as never;
      },
    });
    expect(activeSpacePane).toBe("t11");
    expect(tabCalls).toEqual([{ workspaceId: "sp-1", cwd: "/repos/app-one", label: "Task Two" }]);

    // 3. Matching snapshot workspace without herdr-app doc uses tabCreate
    const snapWorkspacePane = await openQueueTab("/repos/wt-branch", "Branch Task", {
      folderExists: () => true,
      snapshot: async () => emptySnapshot({
        workspaces: [
          { workspace_id: "ws-other", name: "wt", index: 0, focused_tab_id: null, worktree: { checkout_path: "/repos/wt-branch" } } as never,
        ],
      }),
      hc: { async call() { return null as never; } },
      tabCreate: async (opts) => ({ root_pane: { pane_id: `tab:${opts.workspaceId}` } }) as never,
    });
    expect(snapWorkspacePane).toBe("tab:ws-other");

    // 4. Fallback workspaceCreate named after folder basename + terminal.label
    const wsCalls: Array<{ cwd?: string; label?: string }> = [];
    const labelCalls: Array<{ terminal: string; labels: Record<string, string> }> = [];
    const createdPane = await openQueueTab("/srv/work/brand-new", "First Job", {
      folderExists: () => true,
      snapshot: async () => emptySnapshot(),
      hc: {
        async call(method: string, params: Record<string, unknown>) {
          if (method === "doc.get") return null as never;
          if (method === "terminal.label") {
            labelCalls.push(params as never);
            return {} as never;
          }
          throw new Error(`unexpected ${method}`);
        },
      },
      workspaceCreate: async (opts) => {
        wsCalls.push(opts);
        return { root_pane: { pane_id: "t20" } } as never;
      },
    });
    expect(createdPane).toBe("t20");
    expect(wsCalls).toEqual([{ cwd: "/srv/work/brand-new", label: "brand-new" }]);
    expect(labelCalls).toEqual([{ terminal: "t20", labels: { "ovis.tab": "First Job" } }]);

    // 5. Rejects nonexistent folders
    await expect(
      openQueueTab("/does/not/exist", "Oops", { folderExists: () => false }),
    ).rejects.toThrow("Project folder does not exist");
  });

  it("deliverQueuePrompt waits for readiness, retries transient errors, and stops on closed panes", async () => {
    let clock = 0;
    let poll = 0;
    const events: string[] = [];
    let promptAttempts = 0;

    await deliverQueuePrompt("t1", "Run tests\nand report", {
      timeoutMs: 500,
      pollMs: 25,
      settleMs: 50,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      hc: {
        call: (async () => {
          poll += 1;
          if (poll === 1) return makeTerminal("t1", { status: null });
          if (poll === 2) return makeTerminal("t1", { status: { state: "blocked", app: "claude" } });
          return makeTerminal("t1", { status: { state: "idle", app: "claude" } });
        }) as never,
      },
      paneGet: async () => ({
        pane_id: "t1",
        agent: poll >= 2 ? "claude" : null,
      }) as never,
      beforeSend: () => events.push(`before:${poll}`),
      onRetry: () => events.push(`retry:${poll}`),
      sendPrompt: async (_paneId, text) => {
        promptAttempts += 1;
        events.push(`send:${promptAttempts}:${text}`);
        if (promptAttempts === 1) {
          throw new HerdrError("agent_not_ready", "still booting");
        }
      },
    });

    expect(events).toEqual([
      "before:3",
      "send:1:Run tests\nand report",
      "retry:3",
      "before:4",
      "send:2:Run tests\nand report",
    ]);

    await expect(
      deliverQueuePrompt("t-gone", "Hi", {
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
        hc: {
          async call() {
            throw new HcError("not_found", "missing terminal");
          },
        },
      }),
    ).rejects.toThrow("no longer exists");

    await expect(
      deliverQueuePrompt("t-ended", "Hi", {
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
        hc: {
          call: (async () => makeTerminal("t-ended", { state: "ended" })) as never,
        },
      }),
    ).rejects.toThrow("ended before prompt delivery");
  });
});

describe("AgentQueueService", () => {
  it("enforces paused, minMemMb, maxWorking, one-per-project, cooldownSec, hold, and max 1 launch per tick", async () => {
    const dir = makeTempDir();
    let clock = Date.parse("2026-11-18T10:00:00.000Z");
    let memAvailableMb: number | null = 4096;
    let terminals: HcTerminal[] = [];
    const launches: Array<{ folder: string; title: string; agent: string; paneId: string; prompt: string }> = [];
    let paneCounter = 0;

    const service = new AgentQueueService({
      stateDir: dir,
      getPreferences: () => EMPTY_PREFERENCES,
      now: () => clock,
      readMemAvailableMb: () => memAvailableMb,
      getTerminals: async () => terminals,
      resolveReal: (path) => path === "/srv/alias-a" ? "/srv/proj-a" : path,
      openTab: async (folder, title) => {
        paneCounter += 1;
        const paneId = `p${paneCounter}:${folder}:${title}`;
        terminals = [...terminals, makeTerminal(paneId, { status: { state: "idle", app: "claude" } })];
        return paneId;
      },
      launchAgent: async () => ({ agent_started: true }),
      deliverPrompt: async (paneId, text, deps) => {
        deps?.beforeSend?.();
        const [, folder = "", title = ""] = paneId.split(":");
        launches.push({ folder, title, agent: "pending", paneId, prompt: text });
      },
      forgetLaunchedAgent: () => {},
    });

    const aHold = service.createTask({ folder: "/srv/proj-a", title: "Hold A", prompt: "Do later", hold: true }).task;
    const a1 = service.createTask({ folder: "/srv/proj-a", title: "A1", prompt: "First A" }).task;
    const a2 = service.createTask({ folder: "/srv/alias-a", title: "A2 alias", prompt: "Second A" }).task;
    const b1 = service.createTask({ folder: "/srv/proj-b", title: "B1", prompt: "First B" }).task;

    // 1. Paused gate blocks launch
    service.updateSettings({ paused: true });
    let snap = await service.tick();
    expect(snap.gate.status).toBe("paused");
    expect(launches).toHaveLength(0);

    // 2. minMemMb gate blocks launch
    service.updateSettings({ paused: false, minMemMb: 2048 });
    memAvailableMb = 1500;
    snap = await service.tick();
    expect(snap.gate.status).toBe("low_memory");
    expect(snap.gate.summary).toBe("Waiting: 1.5 GB free < 2 GB");
    expect(launches).toHaveLength(0);

    // 3. maxWorking gate counts all live local hc working terminals
    memAvailableMb = 4096;
    service.updateSettings({ maxWorking: 2 });
    terminals = [
      makeTerminal("ext-1", { status: { state: "working", app: "claude" } }),
      makeTerminal("ext-2", { status: { state: "working", app: "codex" } }),
    ];
    snap = await service.tick();
    expect(snap.gate.status).toBe("max_working");
    expect(snap.gate.summary).toBe("Waiting: 2 agents working");
    expect(launches).toHaveLength(0);

    // 4. Eligible -> skips aHold, launches ONLY a1 (max 1 per tick)
    terminals = [makeTerminal("ext-1", { status: { state: "idle", app: "claude" } })];
    snap = await service.tick();
    expect(launches).toHaveLength(1);
    expect(launches[0]!.title).toBe("A1");
    expect(snap.tasks.find((task) => task.id === aHold.id)?.status).toBe("queued");
    expect(snap.tasks.find((task) => task.id === a1.id)?.status).toBe("running");
    expect(snap.tasks.find((task) => task.id === b1.id)?.status).toBe("queued");
    expect(snap.lastLaunchAt).toBe("2026-11-18T10:00:00.000Z");

    // 5. Cooldown gate blocks B1 until cooldownSec elapses
    clock += 60_000;
    snap = await service.tick();
    expect(snap.gate.status).toBe("cooldown");
    expect(snap.gate.summary).toBe("Cooldown: 2m");
    expect(launches).toHaveLength(1);

    // 6. After cooldown, project-a alias is STILL skipped because a1 is running; launches B1 instead
    clock += 120_000;
    snap = await service.tick();
    expect(launches).toHaveLength(2);
    expect(launches[1]!.title).toBe("B1");
    expect(snap.tasks.find((task) => task.id === a2.id)?.status).toBe("queued");
    expect(snap.tasks.find((task) => task.id === b1.id)?.status).toBe("running");

    // 7. After cooldown and completing a1, alias A2 launches cleanly
    service.onPaneStatus(snap.tasks.find((task) => task.id === a1.id)!.terminal!, "done", "claude");
    clock += 180_000;
    snap = await service.tick();
    expect(launches).toHaveLength(3);
    expect(launches[2]!.title).toBe("A2 alias");
  });

  it("handles startNow overrides and project_busy conflicts, plus launch specs for Codex positional vs multiline", async () => {
    const dir = makeTempDir();
    let clock = Date.parse("2026-11-18T11:00:00.000Z");
    const launchedArgs: Array<{ paneId: string; kind: unknown; args: unknown; positionalForgot: boolean }> = [];
    const delivered: Array<{ paneId: string; text: string }> = [];
    const forgotten: string[] = [];
    const terminals: HcTerminal[] = [makeTerminal("w1", { status: { state: "working" } })];
    let nextPane = 0;

    const service = new AgentQueueService({
      stateDir: dir,
      getPreferences: () => ({
        ...EMPTY_PREFERENCES,
        settings: { codexLaunchMode: "auto", codexLaunchModel: "gpt-5.4", codexLaunchEffort: "high" },
      }),
      now: () => clock,
      readMemAvailableMb: () => 512, // below minMemMb
      getTerminals: async () => terminals,
      resolveReal: (path) => path === "/srv/repo-link" ? "/srv/repo" : path,
      openTab: async () => {
        const id = `pane-${++nextPane}`;
        terminals.push(makeTerminal(id, { status: { state: "idle" } }));
        return id;
      },
      launchAgent: async (paneId, agent) => {
        launchedArgs.push({ paneId, kind: agent.kind, args: agent.args, positionalForgot: forgotten.includes(paneId) });
        return { agent_started: true };
      },
      deliverPrompt: async (paneId, text) => {
        delivered.push({ paneId, text });
      },
      forgetLaunchedAgent: (paneId) => { forgotten.push(paneId); },
    });

    // Global pause + hold + low memory + working count should all be bypassed by startNow
    service.updateSettings({ paused: true, minMemMb: 8192, maxWorking: 1 });
    const codexSingle = service.createTask({
      folder: "/srv/repo",
      agent: "codex",
      prompt: "Run single line check",
      hold: true,
    }).task;
    const codexSibling = service.createTask({
      folder: "/srv/repo-link",
      agent: "codex",
      prompt: "Line 1\nLine 2",
    }).task;
    const claudeTask = service.createTask({
      folder: "/srv/other",
      agent: "claude",
      prompt: "Audit routes",
      hold: true,
    }).task;

    // Missing / unknown ID throws QueueNotFoundError
    await expect(service.startNow("missing-id")).rejects.toBeInstanceOf(QueueNotFoundError);

    // Start single-line Codex -> positional CLI prompt, no deliverPrompt call, forgetLaunchedAgent called
    const started1 = await service.startNow(codexSingle.id);
    expect(started1.task.status).toBe("running");
    expect(started1.task.terminal).toBe("pane-1");
    expect(launchedArgs[0]!.args).toEqual(["--sandbox", "workspace-write", "--ask-for-approval", "on-request", "--model", "gpt-5.4", "-c", "model_reasoning_effort=high", "--", "Run single line check"]);
    expect(forgotten).toEqual(["pane-1"]);
    expect(delivered).toHaveLength(0);

    // Same canonical folder blocked with QueueConflictError("project_busy")
    await expect(service.startNow(codexSibling.id)).rejects.toMatchObject({ code: "project_busy" });
    // Starting an already-running task throws QueueConflictError("task_not_queued")
    await expect(service.startNow(codexSingle.id)).rejects.toBeInstanceOf(QueueConflictError);

    // Finish codexSingle, start multiline Codex -> uses pending delivery
    service.onPaneStatus("pane-1", "working", "codex");
    service.onPaneStatus("pane-1", "done", "codex");
    const started2 = await service.startNow(codexSibling.id);
    expect(started2.task.terminal).toBe("pane-2");
    expect(delivered).toEqual([{ paneId: "pane-2", text: "Line 1\nLine 2" }]);

    // Other project can start in parallel via startNow -> Claude uses pending delivery
    const started3 = await service.startNow(claudeTask.id);
    expect(started3.task.terminal).toBe("pane-3");
    expect(delivered[1]).toEqual({ paneId: "pane-3", text: "Audit routes" });
  });

  it("tracks lifecycle, ignores startup/error rests, handles pane moves and restarts/reconcile", async () => {
    const dir = makeTempDir();
    let clock = Date.parse("2026-11-18T12:00:00.000Z");
    let terminals: HcTerminal[] = [];
    let beforeSendHook: (() => void) | undefined;
    let markDeliverEntered!: () => void;
    const deliverEntered = new Promise<void>((resolve) => { markDeliverEntered = resolve; });
    let finishDeliver!: () => void;

    const service = new AgentQueueService({
      stateDir: dir,
      getPreferences: () => EMPTY_PREFERENCES,
      now: () => clock,
      readMemAvailableMb: () => 8192,
      getTerminals: async () => terminals,
      openTab: async () => "p-live",
      launchAgent: async () => ({ agent_started: true }),
      deliverPrompt: async (_paneId, _text, deps) => {
        beforeSendHook = deps?.beforeSend;
        markDeliverEntered();
        await new Promise<void>((resolve) => { finishDeliver = resolve; });
      },
      forgetLaunchedAgent: () => {},
    });

    const t1 = service.createTask({ folder: "/srv/a", title: "Task 1", prompt: "Do work" }).task;

    // Begin launch in background and wait until deliverPrompt begins
    const startPromise = service.startNow(t1.id);
    await deliverEntered;

    // Startup noise (done/idle before beforeSend) must NOT mark task done
    service.onPaneStatus("p-live", "working", "claude");
    service.onPaneStatus("p-live", "done", "claude");
    expect(service.cachedSnapshot().tasks[0]!.status).toBe("running");

    // Prompt actually sent -> fast turn finishes inside deliverPrompt
    beforeSendHook?.();
    service.onPaneStatus("p-live", "working", "claude");
    // While working -> blocked stays running
    service.onPaneStatus("p-live", "blocked", "claude");
    expect(service.cachedSnapshot().tasks[0]!.status).toBe("running");
    // Pane moves during prompt delivery
    service.onPaneMoved("p-live", "p-moved");
    // Finishes before deliverPrompt resolves
    service.onPaneStatus("p-moved", "idle", "claude");
    finishDeliver();

    const launched = await startPromise;
    expect(launched.task.status).toBe("done");
    expect(launched.task.terminal).toBe("p-moved");
    expect(launched.task.finishedAt).toBe("2026-11-18T12:00:00.000Z");

    // Failed rollout rest (`failedRest = true`) must NOT mark running task done on idle
    clock += 1000;
    const t2 = service.createTask({ folder: "/srv/b", prompt: "Second" }).task;
    let markT2Delivered!: () => void;
    const t2Entered = new Promise<void>((resolve) => { markT2Delivered = resolve; });
    let sendT2!: () => void;
    const fastService = new AgentQueueService({
      stateDir: dir,
      getPreferences: () => EMPTY_PREFERENCES,
      now: () => clock,
      readMemAvailableMb: () => 8192,
      getTerminals: async () => terminals,
      openTab: async () => "p-b",
      launchAgent: async () => ({ agent_started: true }),
      deliverPrompt: async (_paneId, _text, deps) => {
        deps?.beforeSend?.();
        markT2Delivered();
        await new Promise<void>((resolve) => { sendT2 = resolve; });
      },
      forgetLaunchedAgent: () => {},
    });
    const t2Promise = fastService.startNow(t2.id);
    await t2Entered;
    sendT2();
    await t2Promise;

    fastService.onPaneStatus("p-b", "working", "codex", false);
    fastService.onPaneStatus("p-b", "idle", "codex", true);
    expect(fastService.cachedSnapshot().tasks.find((x) => x.id === t2.id)?.status).toBe("running");

    // Terminal closed marks task failed
    fastService.onPaneGone("p-b", "Terminal ended");
    const failedT2 = fastService.cachedSnapshot().tasks.find((x) => x.id === t2.id)!;
    expect(failedT2.status).toBe("failed");
    expect(failedT2.error).toBe("Terminal ended");

    // Simulate server restart and reconcile against terminals
    const t3 = fastService.createTask({ folder: "/srv/c", prompt: "Third" }).task;
    const restarted = new AgentQueueService({
      stateDir: dir,
      getPreferences: () => EMPTY_PREFERENCES,
      now: () => clock,
      readMemAvailableMb: () => 8192,
      getTerminals: async () => terminals,
      openTab: async () => "p-c",
      launchAgent: async () => ({ agent_started: true }),
      deliverPrompt: async (_paneId, _text, deps) => { deps?.beforeSend?.(); },
      forgetLaunchedAgent: () => {},
    });
    await restarted.startNow(t3.id);

    // New service instance reading disk from prior run
    terminals = [makeTerminal("p-c", { status: { state: "working", app: "claude" } })];
    const recovered = new AgentQueueService({
      stateDir: dir,
      getPreferences: () => EMPTY_PREFERENCES,
      now: () => clock,
      readMemAvailableMb: () => 8192,
      getTerminals: async () => terminals,
    });
    await recovered.reconcile();
    expect(recovered.cachedSnapshot().tasks.find((x) => x.id === t3.id)?.status).toBe("running");

    // Terminal seen at idle after reconcile recorded working -> marks done cleanly
    clock += 5000;
    terminals = [makeTerminal("p-c", { status: { state: "idle", app: "claude" } })];
    await recovered.reconcile();
    const doneT3 = recovered.cachedSnapshot().tasks.find((x) => x.id === t3.id)!;
    expect(doneT3.status).toBe("done");
    expect(doneT3.finishedAt).toBe("2026-11-18T12:00:06.000Z");

    // Running task whose terminal disappeared -> failed with "Terminal closed"
    const t4 = recovered.createTask({ folder: "/srv/d", prompt: "Missing pane" }).task;
    recovered.store.markTaskRunning(t4.id, "p-gone");
    terminals = [];
    await recovered.reconcile();
    const missingT4 = recovered.cachedSnapshot().tasks.find((x) => x.id === t4.id)!;
    expect(missingT4.status).toBe("failed");
    expect(missingT4.error).toBe("Terminal closed");
  });

  it("records failure reason when launchAgent fails and emits deduplicated machine-events frames", async () => {
    const dir = makeTempDir();
    const clock = Date.parse("2026-11-18T13:00:00.000Z");
    let mem = 8192;
    const events: MachineEvent[] = [];

    const service = new AgentQueueService({
      stateDir: dir,
      getPreferences: () => EMPTY_PREFERENCES,
      now: () => clock,
      readMemAvailableMb: () => mem,
      getTerminals: async () => [],
      openTab: async () => "p-fail",
      launchAgent: async () => ({ agent_started: false, error: { code: "agent_not_found", message: "claude missing" } }),
    });

    const stop = subscribeMachineEvents(
      {
        manager: { subscribe: () => () => {} },
        agentQueue: service,
      },
      (event) => events.push(event),
    );

    const task = service.createTask({ folder: "/srv/fail", prompt: "Should fail" }).task;
    const res = await service.startNow(task.id);
    expect(res.task.status).toBe("failed");
    expect(res.task.error).toBe("claude missing");
    expect(res.task.terminal).toBe("p-fail");

    // Repeated snapshot with unchanged state emits no duplicate frame
    const beforeCount = events.filter((event) => event.type === "agent-queue").length;
    await service.snapshot();
    expect(events.filter((event) => event.type === "agent-queue")).toHaveLength(beforeCount);

    // Change in memory availability emits fresh gate snapshot
    mem = 512;
    await service.snapshot();
    const afterEvents = events.filter((event) => event.type === "agent-queue");
    expect(afterEvents).toHaveLength(beforeCount + 1);
    const latest = afterEvents.at(-1)!;
    expect(latest.type === "agent-queue" && latest.queue.gate.status).toBe("low_memory");
    stop();
  });
});
