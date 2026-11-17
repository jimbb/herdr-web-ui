/**
 * Per-project agent task queue contract shared by the Ovis server, the browser UI and the demo.
 * Tasks inside each project folder run sequentially according to their array order when global
 * resource and cooldown gates allow.
 */

export type QueueTaskStatus = "queued" | "running" | "done" | "failed";

export const QUEUE_TASK_STATUSES: readonly QueueTaskStatus[] = ["queued", "running", "done", "failed"] as const;

export const DEFAULT_QUEUE_AGENT = "claude";
export const VALID_QUEUE_AGENT = /^[a-z][a-z0-9-]*$/;

export interface QueueTask {
  id: string;
  folder: string;
  title: string;
  prompt: string;
  agent: string;
  hold: boolean;
  status: QueueTaskStatus;
  needsInput?: boolean;
  terminal: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface QueueSettings {
  paused: boolean;
  minMemMb: number;
  maxWorking: number;
  cooldownSec: number;
}

export const DEFAULT_QUEUE_SETTINGS: QueueSettings = {
  paused: false,
  minMemMb: 2048,
  maxWorking: 6,
  cooldownSec: 180,
};

export type QueueGateStatus = "ready" | "paused" | "low_memory" | "max_working" | "cooldown" | "project_busy" | "idle";

export interface QueueGateState {
  status: QueueGateStatus;
  summary: string;
  memAvailableMb: number | null;
  workingCount: number;
  cooldownLeftSec: number;
}

export interface QueueSnapshot {
  version: 1;
  settings: QueueSettings;
  tasks: QueueTask[];
  gate: QueueGateState;
  lastLaunchAt: string | null;
}

export interface QueueCreateTaskRequest {
  folder: string;
  title?: string;
  prompt: string;
  agent?: string;
  hold?: boolean;
}

export interface QueueUpdateTaskRequest {
  folder?: string;
  title?: string;
  prompt?: string;
  agent?: string;
  hold?: boolean;
  status?: "queued";
}

export type QueueReorderRequest =
  | { folder: string; orderedIds: string[] }
  | { id: string; direction: "up" | "down" };

export type QueueUpdateSettingsRequest = Partial<QueueSettings>;

/** Lexically strips trailing separators (keeping POSIX `/` and Windows `C:\`) without regex lookbehinds. */
export function normalizeQueueFolder(raw: string): string {
  let folder = raw.trim();
  while (folder.length > 1 && (folder.endsWith("/") || folder.endsWith("\\"))) {
    if (folder.length === 3 && folder[1] === ":" && (folder[2] === "\\" || folder[2] === "/")) break;
    folder = folder.slice(0, -1);
  }
  return folder;
}

/** Short display/workspace label from a project path (its last segment, or the path itself at root). */
export function queueFolderName(folder: string): string {
  const clean = normalizeQueueFolder(folder);
  const slash = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  if (slash < 0) return clean || "project";
  const base = clean.slice(slash + 1);
  return base || clean;
}

/** Derives a compact title from a task prompt when none is explicitly set. */
export function queueTaskTitleFallback(prompt: string, maxChars = 64): string {
  const firstLine = prompt.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine) return "Untitled task";
  return firstLine.length <= maxChars ? firstLine : `${firstLine.slice(0, maxChars - 1).trimEnd()}…`;
}

/** Formats megabytes in gigabytes concisely (`2 GB`, `1.6 GB`). */
export function formatQueueGb(mb: number): string {
  const fixed = (mb / 1024).toFixed(1);
  return `${fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed} GB`;
}

/** Formats seconds concisely (`1m 20s`, `45s`, `3m`). */
export function formatQueueDuration(seconds: number): string {
  const clamped = Math.max(0, Math.ceil(seconds));
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  if (mins === 0) return `${secs}s`;
  if (secs === 0) return `${mins}m`;
  return `${mins}m ${secs}s`;
}
