import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_QUEUE_SETTINGS } from "../shared/agent-queue.ts";
import {
  AgentQueueStore,
  evaluateQueueGate,
  parseProcMemAvailableMb,
  pickNextQueueTask,
  QUEUE_FILE_NAME,
  QueueConflictError,
  QueueValidationError,
} from "./agent-queue-store.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-queue-store-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("AgentQueueStore", () => {
  it("starts empty without creating a file, then persists atomically with defaults", () => {
    const dir = makeTempDir();
    let clock = Date.parse("2026-11-18T00:00:00.000Z");
    const store = new AgentQueueStore(dir, { home: () => "/home/tester", now: () => clock });

    expect(existsSync(join(dir, QUEUE_FILE_NAME))).toBe(false);
    expect(store.getDocument()).toEqual({
      version: 1,
      settings: DEFAULT_QUEUE_SETTINGS,
      lastLaunchAt: null,
      tasks: [],
    });

    const created = store.createTask({
      folder: "~/repos/ovis/",
      prompt: "Implement queue view\nand verify on mobile",
    });

    expect(created.folder).toBe("/home/tester/repos/ovis");
    expect(created.title).toBe("Implement queue view");
    expect(created.agent).toBe("claude");
    expect(created.hold).toBe(false);
    expect(created.status).toBe("queued");
    expect(created.terminal).toBeNull();
    expect(created.createdAt).toBe("2026-11-18T00:00:00.000Z");

    clock += 1000;
    const reloaded = new AgentQueueStore(dir, { home: () => "/home/tester", now: () => clock });
    expect(reloaded.getDocument().tasks).toEqual([created]);
  });

  it("picks up hand-edited JSON changes on mtime change and normalizes missing defaults", () => {
    const dir = makeTempDir();
    const queuePath = join(dir, QUEUE_FILE_NAME);
    let clock = Date.parse("2026-11-18T01:00:00.000Z");
    const store = new AgentQueueStore(dir, { home: () => "/home/tester", now: () => clock });

    const first = store.createTask({ folder: "/srv/app", prompt: "First task", title: "First" });

    // Hand-edit: append a minimal task entry with missing id/agent/hold/status/createdAt and tweak settings.
    const handEdited = {
      version: 1,
      settings: { paused: true, minMemMb: 1024 },
      tasks: [
        first,
        {
          folder: "~/notes/",
          prompt: "Summarize today's diff\nwith bullets",
        },
      ],
    };
    writeFileSync(queuePath, `${JSON.stringify(handEdited, null, 2)}\n`);
    const future = new Date(Date.now() + 5000);
    utimesSync(queuePath, future, future);

    let notified = 0;
    store.subscribe(() => { notified += 1; });

    const { changed } = store.syncIfChanged();
    expect(changed).toBe(true);
    expect(notified).toBe(1);

    const doc = store.getDocument();
    expect(doc.settings).toEqual({
      paused: true,
      minMemMb: 1024,
      maxWorking: 6,
      cooldownSec: 180,
    });
    expect(doc.tasks).toHaveLength(2);
    expect(doc.tasks[1]!.id.length).toBeGreaterThan(0);
    expect(doc.tasks[1]!.folder).toBe("/home/tester/notes");
    expect(doc.tasks[1]!.title).toBe("Summarize today's diff");
    expect(doc.tasks[1]!.agent).toBe("claude");
    expect(doc.tasks[1]!.hold).toBe(false);
    expect(doc.tasks[1]!.status).toBe("queued");

    // Normalized defaults were persisted back cleanly on disk.
    const writtenBack = JSON.parse(readFileSync(queuePath, "utf8"));
    expect(writtenBack.tasks[1].id).toBe(doc.tasks[1]!.id);
    // Immediate re-sync without another edit is a no-op.
    expect(store.syncIfChanged().changed).toBe(false);
  });

  it("keeps prior good state without overwriting if a hand-edit leaves broken JSON", () => {
    const dir = makeTempDir();
    const queuePath = join(dir, QUEUE_FILE_NAME);
    const store = new AgentQueueStore(dir, { home: () => "/home/tester" });
    const created = store.createTask({ folder: "/srv/app", prompt: "Keep me safe" });

    writeFileSync(queuePath, "{ invalid json");
    const t1 = new Date(Date.now() + 2000);
    utimesSync(queuePath, t1, t1);

    expect(store.syncIfChanged().changed).toBe(false);
    expect(store.getDocument().tasks).toEqual([created]);
    expect(readFileSync(queuePath, "utf8")).toBe("{ invalid json");

    // Once the user finishes editing and saves valid JSON, sync picks it up.
    writeFileSync(queuePath, JSON.stringify({
      version: 1,
      settings: DEFAULT_QUEUE_SETTINGS,
      tasks: [created, { id: "hand-2", folder: "/srv/other", prompt: "Second" }],
    }));
    const t2 = new Date(Date.now() + 4000);
    utimesSync(queuePath, t2, t2);

    expect(store.syncIfChanged().changed).toBe(true);
    expect(store.getDocument().tasks.map((task) => task.id)).toEqual([created.id, "hand-2"]);
  });

  it("reorders tasks within a folder by orderedIds and by up/down direction without disturbing other folders", () => {
    const dir = makeTempDir();
    const store = new AgentQueueStore(dir, { home: () => "/home/tester" });
    const a1 = store.createTask({ folder: "/proj/a", prompt: "A1", title: "A1" });
    const b1 = store.createTask({ folder: "/proj/b", prompt: "B1", title: "B1" });
    const a2 = store.createTask({ folder: "/proj/a", prompt: "A2", title: "A2" });
    const a3 = store.createTask({ folder: "/proj/a", prompt: "A3", title: "A3" });

    store.reorder({ folder: "/proj/a", orderedIds: [a3.id, a1.id, a2.id] });
    expect(store.getDocument().tasks.map((task) => task.id)).toEqual([a3.id, b1.id, a1.id, a2.id]);

    store.reorder({ id: a1.id, direction: "up" });
    expect(store.getDocument().tasks.map((task) => task.id)).toEqual([a1.id, b1.id, a3.id, a2.id]);

    store.reorder({ id: a3.id, direction: "down" });
    expect(store.getDocument().tasks.map((task) => task.id)).toEqual([a1.id, b1.id, a2.id, a3.id]);
  });

  it("enforces running task edit/delete constraints and supports requeuing finished/failed tasks", () => {
    const dir = makeTempDir();
    const store = new AgentQueueStore(dir, { home: () => "/home/tester" });
    const task = store.createTask({ folder: "/proj/a", prompt: "Run work" });
    store.markTaskRunning(task.id, "t7", "2026-11-18T00:05:00.000Z");

    expect(() => store.updateTask(task.id, { prompt: "Changed" })).toThrow(QueueConflictError);
    expect(() => store.updateTask(task.id, { status: "queued" })).toThrow(QueueConflictError);
    expect(() => store.deleteTask(task.id)).toThrow(QueueConflictError);

    const updatedTitle = store.updateTask(task.id, { title: "Renamed while running" });
    expect(updatedTitle.title).toBe("Renamed while running");

    const failed = store.markTaskFailed(task.id, "Terminal ended", "t7", "2026-11-18T00:06:00.000Z");
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("Terminal ended");

    const requeued = store.updateTask(task.id, { status: "queued" });
    expect(requeued.status).toBe("queued");
    expect(requeued.terminal).toBeNull();
    expect(requeued.startedAt).toBeNull();
    expect(requeued.finishedAt).toBeNull();
    expect(requeued.error).toBeNull();
    expect(requeued.needsInput).toBeUndefined();

    store.deleteTask(task.id);
    expect(store.getDocument().tasks).toEqual([]);
  });

  it("tracks needsInput only on running tasks and clears it cleanly on transitions and sanitization", () => {
    const dir = makeTempDir();
    const queuePath = join(dir, QUEUE_FILE_NAME);
    const store = new AgentQueueStore(dir, { home: () => "/home/tester" });
    const queuedTask = store.createTask({ folder: "/proj/a", prompt: "Needs input test" });
    expect(queuedTask.needsInput).toBeUndefined();

    // Non-running tasks ignore setTaskNeedsInput.
    let changes = 0;
    const unsub = store.subscribe(() => { changes += 1; });
    expect(store.setTaskNeedsInput(queuedTask.id, true)).toBeNull();
    expect(changes).toBe(0);

    // Running task accepts setTaskNeedsInput(true), is idempotent, and persists to disk.
    store.markTaskRunning(queuedTask.id, "t-needs");
    changes = 0;
    const blocked = store.setTaskNeedsInput(queuedTask.id, true);
    expect(blocked?.needsInput).toBe(true);
    expect(changes).toBe(1);
    expect(store.setTaskNeedsInput(queuedTask.id, true)?.needsInput).toBe(true);
    expect(changes).toBe(1);

    // Reloading retains needsInput on running tasks and strips stale needsInput on non-running tasks.
    const reloaded = new AgentQueueStore(dir, { home: () => "/home/tester" });
    expect(reloaded.getDocument().tasks[0]?.needsInput).toBe(true);

    writeFileSync(
      queuePath,
      JSON.stringify({
        version: 1,
        settings: DEFAULT_QUEUE_SETTINGS,
        tasks: [
          { ...blocked, needsInput: true },
          { ...queuedTask, id: "stale-queued", status: "queued", needsInput: true },
          { ...queuedTask, id: "stale-failed", status: "failed", error: "err", needsInput: true },
        ],
      }),
    );
    const future = new Date(Date.now() + 5000);
    utimesSync(queuePath, future, future);
    expect(reloaded.syncIfChanged().changed).toBe(true);
    const syncedTasks = reloaded.getDocument().tasks;
    expect(syncedTasks[0]?.needsInput).toBe(true);
    expect(syncedTasks[1]?.needsInput).toBeUndefined();
    expect(syncedTasks[2]?.needsInput).toBeUndefined();

    // Transitions clear needsInput.
    expect(reloaded.setTaskNeedsInput(queuedTask.id, false)?.needsInput).toBeUndefined();
    reloaded.setTaskNeedsInput(queuedTask.id, true);
    expect(reloaded.markTaskRunning(queuedTask.id, "t-needs-2").needsInput).toBeUndefined();
    reloaded.setTaskNeedsInput(queuedTask.id, true);
    expect(reloaded.markTaskDone(queuedTask.id).needsInput).toBeUndefined();

    const tFail = reloaded.createTask({ folder: "/proj/b", prompt: "Fail clears needsInput" });
    reloaded.markTaskRunning(tFail.id, "t-fail");
    reloaded.setTaskNeedsInput(tFail.id, true);
    expect(reloaded.markTaskFailed(tFail.id, "Agent exited").needsInput).toBeUndefined();
    unsub();
  });

  it("validates task fields and settings updates", () => {
    const dir = makeTempDir();
    const store = new AgentQueueStore(dir);
    expect(() => store.createTask({ folder: "  ", prompt: "hi" })).toThrow(QueueValidationError);
    expect(() => store.createTask({ folder: "/proj/a", prompt: "  " })).toThrow(QueueValidationError);
    expect(() => store.createTask({ folder: "/proj/a", prompt: "hi\u0007" })).toThrow(QueueValidationError);
    expect(() => store.createTask({ folder: "/proj/a", prompt: "hi", agent: "Bad Agent" })).toThrow(QueueValidationError);
    expect(() => store.updateSettings({ maxWorking: 0 })).toThrow(QueueValidationError);
    expect(() => store.updateSettings({ minMemMb: -1 })).toThrow(QueueValidationError);
  });
});

describe("proc meminfo and gate evaluation", () => {
  it("parses MemAvailable from /proc/meminfo in whole MiB", () => {
    const sample = [
      "MemTotal:       16384000 kB",
      "MemFree:          512000 kB",
      "MemAvailable:    1677721 kB",
    ].join("\n");
    expect(parseProcMemAvailableMb(sample)).toBe(1638);
    expect(parseProcMemAvailableMb("MemTotal: 1000 kB\n")).toBeNull();
  });

  it("evaluates paused, low_memory, max_working, cooldown, project_busy, idle, and ready gates", () => {
    const nowMs = Date.parse("2026-11-18T00:03:00.000Z");
    const taskA1 = {
      id: "a1",
      folder: "/proj/a",
      title: "A1",
      prompt: "do A1",
      agent: "claude",
      hold: false,
      status: "queued" as const,
      terminal: null,
      createdAt: "2026-11-18T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      error: null,
    };
    const taskB1 = { ...taskA1, id: "b1", folder: "/proj/b", title: "B1", prompt: "do B1" };
    const doc = {
      settings: { paused: false, minMemMb: 2048, maxWorking: 6, cooldownSec: 180 },
      lastLaunchAt: null as string | null,
      tasks: [taskA1, taskB1],
    };

    expect(evaluateQueueGate({ ...doc, settings: { ...doc.settings, paused: true } }, { memAvailableMb: 4096, workingCount: 0, nowMs })).toMatchObject({
      status: "paused",
      summary: "Paused",
    });

    expect(evaluateQueueGate(doc, { memAvailableMb: 1638, workingCount: 0, nowMs })).toMatchObject({
      status: "low_memory",
      summary: "Waiting: 1.6 GB free < 2 GB",
    });

    expect(evaluateQueueGate(doc, { memAvailableMb: 4096, workingCount: 6, nowMs })).toMatchObject({
      status: "max_working",
      summary: "Waiting: 6 agents working",
    });

    // 100s elapsed since lastLaunchAt out of 180s -> 80s left = 1m 20s.
    const cooldownDoc = { ...doc, lastLaunchAt: "2026-11-18T00:01:20.000Z" };
    expect(evaluateQueueGate(cooldownDoc, { memAvailableMb: 4096, workingCount: 1, nowMs })).toMatchObject({
      status: "cooldown",
      summary: "Cooldown: 1m 20s",
      cooldownLeftSec: 80,
    });

    // Project A busy while project B is free -> B is picked cleanly.
    const busyADoc = {
      ...doc,
      tasks: [{ ...taskA1, status: "running" as const, terminal: "t1" }, { ...taskA1, id: "a2", status: "queued" as const }, taskB1],
    };
    expect(evaluateQueueGate(busyADoc, { memAvailableMb: 4096, workingCount: 1, nowMs })).toMatchObject({
      status: "ready",
      summary: "Ready",
    });
    expect(pickNextQueueTask(busyADoc, { memAvailableMb: 4096, workingCount: 1, nowMs })?.id).toBe("b1");

    // Only queued task belongs to busy project A -> project_busy.
    const onlyBusyADoc = {
      ...doc,
      tasks: [{ ...taskA1, status: "running" as const, terminal: "t1" }, { ...taskA1, id: "a2", status: "queued" as const }],
    };
    expect(evaluateQueueGate(onlyBusyADoc, { memAvailableMb: 4096, workingCount: 1, nowMs })).toMatchObject({
      status: "project_busy",
      summary: "Waiting: project already has a running agent",
    });
    expect(pickNextQueueTask(onlyBusyADoc, { memAvailableMb: 4096, workingCount: 1, nowMs })).toBeNull();

    // Held task alone -> idle and skipped.
    const heldDoc = { ...doc, tasks: [{ ...taskA1, hold: true }] };
    expect(evaluateQueueGate(heldDoc, { memAvailableMb: 4096, workingCount: 0, nowMs })).toMatchObject({
      status: "idle",
      summary: "Idle",
    });
    expect(pickNextQueueTask(heldDoc, { memAvailableMb: 4096, workingCount: 0, nowMs })).toBeNull();
  });

  it("canonicalizes project folders across symlinks when checking 1-per-project exclusion", () => {
    const root = makeTempDir();
    const realDir = join(root, "real-proj");
    mkdirSync(realDir);

    const resolveReal = (path: string) => (path === "/link/proj" ? realDir : path);
    const doc = {
      settings: DEFAULT_QUEUE_SETTINGS,
      lastLaunchAt: null,
      tasks: [
        {
          id: "t1",
          folder: realDir,
          title: "Running",
          prompt: "work",
          agent: "claude",
          hold: false,
          status: "running" as const,
          terminal: "t9",
          createdAt: "2026-11-18T00:00:00.000Z",
          startedAt: "2026-11-18T00:00:00.000Z",
          finishedAt: null,
          error: null,
        },
        {
          id: "t2",
          folder: "/link/proj",
          title: "Queued via symlink",
          prompt: "more work",
          agent: "claude",
          hold: false,
          status: "queued" as const,
          terminal: null,
          createdAt: "2026-11-18T00:01:00.000Z",
          startedAt: null,
          finishedAt: null,
          error: null,
        },
      ],
    };

    expect(pickNextQueueTask(doc, { memAvailableMb: 4096, workingCount: 1 }, resolveReal)).toBeNull();
    expect(evaluateQueueGate(doc, { memAvailableMb: 4096, workingCount: 1 }, { resolveReal }).status).toBe("project_busy");
  });
});
