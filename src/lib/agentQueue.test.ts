import { describe, expect, it } from "bun:test";
import { DEFAULT_QUEUE_SETTINGS, type QueueGateState, type QueueSnapshot, type QueueTask } from "../../shared/agent-queue.ts";
import { translate } from "./i18n.ts";
import {
  describeQueueGate,
  groupQueueTasksByFolder,
  isQueueGateWaiting,
  parseQueueSettingsDraft,
  queueBadgeCounts,
  queueFolderSuggestions,
} from "./agentQueue.ts";

function makeTask(overrides: Partial<QueueTask> & { id: string }): QueueTask {
  return {
    folder: "/srv/proj-a",
    title: overrides.id,
    prompt: `Run ${overrides.id}`,
    agent: "claude",
    hold: false,
    status: "queued",
    terminal: null,
    createdAt: "2026-11-18T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    error: null,
    ...overrides,
  };
}

function makeSnapshot(tasks: QueueTask[] = [], paused = false): QueueSnapshot {
  return {
    version: 1,
    settings: { ...DEFAULT_QUEUE_SETTINGS, paused },
    tasks,
    gate: { status: "idle", summary: "Idle", memAvailableMb: 4096, workingCount: 1, cooldownLeftSec: 0 },
    lastLaunchAt: null,
  };
}

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

describe("agentQueue UI helpers", () => {
  it("groups tasks by normalized folder keeping first-seen folder and array task order", () => {
    const groups = groupQueueTasksByFolder([
      makeTask({ id: "a1", folder: "/repo/alpha/", status: "running", terminal: "t1" }),
      makeTask({ id: "b1", folder: "/repo/beta", status: "queued" }),
      makeTask({ id: "a2", folder: "/repo/alpha", status: "queued" }),
      makeTask({ id: "b2", folder: "/repo/beta/", status: "done" }),
    ]);
    expect(groups.map((g) => g.folder)).toEqual(["/repo/alpha", "/repo/beta"]);
    expect(groups[0]!.name).toBe("alpha");
    expect(groups[0]!.runningTask?.id).toBe("a1");
    expect(groups[0]!.queuedCount).toBe(1);
    expect(groups[0]!.tasks.map((t) => t.id)).toEqual(["a1", "a2"]);
    expect(groups[1]!.runningTask).toBeNull();
    expect(groups[1]!.queuedCount).toBe(1);
    expect(groups[1]!.tasks.map((t) => t.id)).toEqual(["b1", "b2"]);
  });

  it("computes badge counts and paused state", () => {
    expect(queueBadgeCounts(null)).toEqual({ running: 0, queued: 0, active: 0, paused: false });
    const counts = queueBadgeCounts(
      makeSnapshot([
        makeTask({ id: "1", status: "running" }),
        makeTask({ id: "2", status: "queued", hold: true }),
        makeTask({ id: "3", status: "queued", hold: false }),
        makeTask({ id: "4", status: "done" }),
        makeTask({ id: "5", status: "failed" }),
      ], true),
    );
    expect(counts).toEqual({ running: 1, queued: 2, active: 3, paused: true });
  });

  it("formats every gate status cleanly and identifies waiting states", () => {
    const cases: Array<{ gate: QueueGateState; expected: string; waiting: boolean }> = [
      { gate: { status: "paused", summary: "", memAvailableMb: 4096, workingCount: 0, cooldownLeftSec: 0 }, expected: "Paused — automatic launches stopped", waiting: true },
      { gate: { status: "low_memory", summary: "", memAvailableMb: 1638, workingCount: 0, cooldownLeftSec: 0 }, expected: "Waiting: 1.6 GB free < 2 GB", waiting: true },
      { gate: { status: "low_memory", summary: "", memAvailableMb: null, workingCount: 0, cooldownLeftSec: 0 }, expected: "Waiting: low free memory", waiting: true },
      { gate: { status: "max_working", summary: "", memAvailableMb: 4096, workingCount: 6, cooldownLeftSec: 0 }, expected: "Waiting: 6/6 agents working", waiting: true },
      { gate: { status: "cooldown", summary: "", memAvailableMb: 4096, workingCount: 1, cooldownLeftSec: 80 }, expected: "Cooldown 1m 20s", waiting: true },
      { gate: { status: "project_busy", summary: "", memAvailableMb: 4096, workingCount: 1, cooldownLeftSec: 0 }, expected: "All queued projects busy", waiting: true },
      { gate: { status: "ready", summary: "", memAvailableMb: 4096, workingCount: 1, cooldownLeftSec: 0 }, expected: "Ready to launch", waiting: false },
      { gate: { status: "idle", summary: "", memAvailableMb: 4096, workingCount: 0, cooldownLeftSec: 0 }, expected: "Idle — no runnable tasks", waiting: false },
    ];
    for (const c of cases) {
      expect(describeQueueGate(c.gate, DEFAULT_QUEUE_SETTINGS, en)).toBe(c.expected);
      expect(isQueueGateWaiting(c.gate.status)).toBe(c.waiting);
    }
  });

  it("deduplicates folder suggestions keeping current, queued, and recent folders", () => {
    const queue = makeSnapshot([
      makeTask({ id: "1", folder: "/srv/app/" }),
      makeTask({ id: "2", folder: "/srv/other" }),
    ]);
    expect(queueFolderSuggestions(queue, "/srv/current/", ["/srv/app", "/srv/third", "/srv/current"])).toEqual([
      "/srv/current",
      "/srv/app",
      "/srv/other",
      "/srv/third",
    ]);
  });

  it("validates settings inputs strictly", () => {
    expect(parseQueueSettingsDraft({ minMemMb: "0", maxWorking: "1", cooldownSec: "180" })).toEqual({
      minMemMb: 0,
      maxWorking: 1,
      cooldownSec: 180,
    });
    expect(parseQueueSettingsDraft({ minMemMb: "-1", maxWorking: "6", cooldownSec: "180" })).toBeNull();
    expect(parseQueueSettingsDraft({ minMemMb: "2048", maxWorking: "0", cooldownSec: "180" })).toBeNull();
    expect(parseQueueSettingsDraft({ minMemMb: "abc", maxWorking: "6", cooldownSec: "180" })).toBeNull();
  });
});
