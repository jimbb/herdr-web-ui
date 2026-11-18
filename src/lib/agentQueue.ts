import { useEffect, useState } from "react";
import {
  formatQueueDuration,
  formatQueueGb,
  normalizeQueueFolder,
  queueFolderName,
  type QueueGateState,
  type QueueGateStatus,
  type QueueSettings,
  type QueueSnapshot,
  type QueueTask,
} from "../../shared/agent-queue.ts";
import { fetchQueue } from "./api.ts";
import type { Translate } from "./i18n.ts";

/** Manages the local agent-queue snapshot and dialog open state synchronized with server capability and auth. */
export function useAgentQueue(locked: boolean | null, queueEnabled: boolean | null) {
  const [queueSnapshot, setQueueSnapshot] = useState<QueueSnapshot | null>(null);
  const [queueOpen, setQueueOpen] = useState<boolean | string>(false);
  const queueSupported = queueEnabled === true || queueSnapshot !== null;
  useEffect(() => {
    if (locked !== false || queueEnabled === false) {
      setQueueOpen(false);
      setQueueSnapshot(null);
      return;
    }
    if (queueEnabled !== true) return;
    let cancelled = false;
    void fetchQueue()
      .then((fresh) => {
        if (!cancelled) setQueueSnapshot(fresh);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [locked, queueEnabled]);
  return { queueSnapshot, setQueueSnapshot, queueOpen, setQueueOpen, queueSupported };
}

export interface QueueProjectGroup {
  folder: string;
  name: string;
  tasks: QueueTask[];
  runningTask: QueueTask | null;
  queuedCount: number;
}

export interface QueueCounts {
  running: number;
  queued: number;
  active: number;
  paused: boolean;
}

/**
 * Groups tasks by normalized project folder, preserving first-seen folder order and array order
 * inside each folder (the exact order the server dispatcher and reorder API operate on).
 */
export function groupQueueTasksByFolder(tasks: readonly QueueTask[]): QueueProjectGroup[] {
  const byFolder = new Map<string, QueueProjectGroup>();
  for (const task of tasks) {
    const folder = normalizeQueueFolder(task.folder);
    let group = byFolder.get(folder);
    if (!group) {
      group = {
        folder,
        name: queueFolderName(folder),
        tasks: [],
        runningTask: null,
        queuedCount: 0,
      };
      byFolder.set(folder, group);
    }
    group.tasks.push(task);
    if (task.status === "running" && group.runningTask === null) group.runningTask = task;
    if (task.status === "queued") group.queuedCount += 1;
  }
  return [...byFolder.values()];
}

export function inboxQueueState(t: Translate, task?: QueueTask): string {
  return task?.status === "failed" ? t("Failed") : task?.hold ? t("Held") : t("Queued");
}

/** Counts running and queued tasks plus pause state for sidebar badges and header hints. */
export function queueBadgeCounts(queue: QueueSnapshot | null): QueueCounts {
  if (!queue) return { running: 0, queued: 0, active: 0, paused: false };
  let running = 0;
  let queued = 0;
  for (const task of queue.tasks) {
    if (task.status === "running") running += 1;
    else if (task.status === "queued") queued += 1;
  }
  return { running, queued, active: running + queued, paused: queue.settings.paused };
}

/** Formats the dispatcher's current gate status as a localized human-readable sentence. */
export function describeQueueGate(gate: QueueGateState, settings: QueueSettings, t: Translate): string {
  switch (gate.status) {
    case "paused":
      return t("Paused — automatic launches stopped");
    case "low_memory":
      return gate.memAvailableMb !== null
        ? t("Waiting: {free} free < {min}", {
            free: formatQueueGb(gate.memAvailableMb),
            min: formatQueueGb(settings.minMemMb),
          })
        : t("Waiting: low free memory");
    case "max_working":
      return t("Waiting: {working}/{max} agents working", {
        working: gate.workingCount,
        max: settings.maxWorking,
      });
    case "cooldown":
      return t("Cooldown {remaining}", { remaining: formatQueueDuration(gate.cooldownLeftSec) });
    case "project_busy":
      return t("All queued projects busy");
    case "ready":
      return t("Ready to launch");
    case "idle":
      return t("Idle — no runnable tasks");
  }
}

export function isQueueGateWaiting(status: QueueGateStatus): boolean {
  return status === "paused" || status === "low_memory" || status === "max_working" || status === "cooldown" || status === "project_busy";
}

/** Deduplicated project folder suggestions prioritizing current context, existing queue folders, and recents. */
export function queueFolderSuggestions(
  queue: QueueSnapshot | null,
  defaultFolder: string | null,
  recentFolders: readonly string[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const push = (raw: string | null | undefined) => {
    if (!raw) return;
    const normalized = normalizeQueueFolder(raw);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  };
  push(defaultFolder);
  for (const task of queue?.tasks ?? []) push(task.folder);
  for (const recent of recentFolders) push(recent);
  return result;
}

export interface QueueSettingsDraft {
  minMemMb: string;
  maxWorking: string;
  cooldownSec: string;
}

/** Validates and rounds editable queue settings fields, returning `null` if any value is invalid. */
export function parseQueueSettingsDraft(draft: QueueSettingsDraft): {
  minMemMb: number;
  maxWorking: number;
  cooldownSec: number;
} | null {
  const parseWhole = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (trimmed === "" || !/^\d+$/.test(trimmed)) return null;
    const value = Number(trimmed);
    return Number.isSafeInteger(value) ? value : null;
  };
  const minMemMb = parseWhole(draft.minMemMb);
  const maxWorking = parseWhole(draft.maxWorking);
  const cooldownSec = parseWhole(draft.cooldownSec);
  if (minMemMb === null || maxWorking === null || cooldownSec === null) return null;
  if (minMemMb < 0 || maxWorking < 1 || cooldownSec < 0) return null;
  return { minMemMb, maxWorking, cooldownSec };
}
