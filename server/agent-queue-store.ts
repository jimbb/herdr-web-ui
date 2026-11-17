import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  DEFAULT_QUEUE_AGENT,
  DEFAULT_QUEUE_SETTINGS,
  formatQueueDuration,
  formatQueueGb,
  normalizeQueueFolder,
  QUEUE_TASK_STATUSES,
  queueTaskTitleFallback,
  VALID_QUEUE_AGENT,
  type QueueCreateTaskRequest,
  type QueueGateState,
  type QueueReorderRequest,
  type QueueSettings,
  type QueueSnapshot,
  type QueueTask,
  type QueueTaskStatus,
  type QueueUpdateSettingsRequest,
  type QueueUpdateTaskRequest,
} from "../shared/agent-queue.ts";
import { firstMessageFault } from "../shared/launch-rules.ts";
import { isJsonObject } from "./http.ts";
import { damagedCopy, writeStateDocument } from "./state-document.ts";
import { userHome } from "./user-home.ts";

export const QUEUE_FILE_NAME = "agent-queue.json";

export interface QueueDocument {
  version: 1;
  settings: QueueSettings;
  lastLaunchAt: string | null;
  tasks: QueueTask[];
}

export interface QueueMetrics {
  memAvailableMb: number | null;
  workingCount: number;
  nowMs?: number;
}

export class QueueValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "QueueValidationError";
    this.code = code;
  }
}

export class QueueNotFoundError extends Error {
  readonly code = "task_not_found";
  constructor(id: string) {
    super(`Queue task ${id} not found`);
    this.name = "QueueNotFoundError";
  }
}

export class QueueConflictError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "QueueConflictError";
    this.code = code;
  }
}

/** Parses `MemAvailable` from `/proc/meminfo` text in whole MiB; null if absent or invalid. */
export function parseProcMemAvailableMb(text: string): number | null {
  const match = /^MemAvailable:\s+(\d+)\s*kB/m.exec(text);
  if (!match) return null;
  const kb = Number(match[1]);
  return Number.isFinite(kb) && kb >= 0 ? Math.floor(kb / 1024) : null;
}

/** Reads `MemAvailable` from `/proc/meminfo` in MiB; null on non-Linux or unreadable files. */
export function readProcMemAvailableMb(path = "/proc/meminfo"): number | null {
  try {
    return parseProcMemAvailableMb(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Best-effort realpath for comparing project folders, falling back to lexical normalization when absent on disk. */
export function canonicalProjectKey(folder: string, resolveReal: (path: string) => string = defaultRealPath): string {
  const normalized = normalizeQueueFolder(folder);
  try {
    return normalizeQueueFolder(resolveReal(normalized));
  } catch {
    return normalized;
  }
}

function defaultRealPath(path: string): string {
  return realpathSync(path);
}

/** Evaluates global queue gates (and optionally a specific project's busy check). */
export function evaluateQueueGate(
  doc: Pick<QueueDocument, "settings" | "lastLaunchAt" | "tasks">,
  metrics: QueueMetrics,
  options: { projectFolder?: string; resolveReal?: (path: string) => string } = {},
): QueueGateState {
  const nowMs = metrics.nowMs ?? Date.now();
  const lastMs = doc.lastLaunchAt ? Date.parse(doc.lastLaunchAt) : Number.NaN;
  const cooldownLeftSec =
    Number.isFinite(lastMs) && doc.settings.cooldownSec > 0
      ? Math.max(0, Math.ceil((lastMs + doc.settings.cooldownSec * 1000 - nowMs) / 1000))
      : 0;

  const base = {
    memAvailableMb: metrics.memAvailableMb,
    workingCount: metrics.workingCount,
    cooldownLeftSec,
  };

  if (doc.settings.paused) {
    return { status: "paused", summary: "Paused", ...base };
  }
  if (metrics.memAvailableMb !== null && metrics.memAvailableMb < doc.settings.minMemMb) {
    return {
      status: "low_memory",
      summary: `Waiting: ${formatQueueGb(metrics.memAvailableMb)} free < ${formatQueueGb(doc.settings.minMemMb)}`,
      ...base,
    };
  }
  if (metrics.workingCount >= doc.settings.maxWorking) {
    return {
      status: "max_working",
      summary: `Waiting: ${metrics.workingCount} ${metrics.workingCount === 1 ? "agent" : "agents"} working`,
      ...base,
    };
  }
  if (cooldownLeftSec > 0) {
    return {
      status: "cooldown",
      summary: `Cooldown: ${formatQueueDuration(cooldownLeftSec)}`,
      ...base,
    };
  }

  const keyOf = (folder: string) => canonicalProjectKey(folder, options.resolveReal);
  const runningKeys = new Set(doc.tasks.filter((task) => task.status === "running").map((task) => keyOf(task.folder)));

  if (options.projectFolder !== undefined) {
    if (runningKeys.has(keyOf(options.projectFolder))) {
      return { status: "project_busy", summary: "Waiting: project already has a running agent", ...base };
    }
    return { status: "ready", summary: "Ready", ...base };
  }

  const eligible = doc.tasks.filter((task) => task.status === "queued" && !task.hold);
  if (eligible.length === 0) {
    return { status: "idle", summary: "Idle", ...base };
  }
  if (eligible.every((task) => runningKeys.has(keyOf(task.folder)))) {
    return { status: "project_busy", summary: "Waiting: project already has a running agent", ...base };
  }
  return { status: "ready", summary: "Ready", ...base };
}

/** Returns the first un-held queued task whose project has no running task when all gates pass, else null. */
export function pickNextQueueTask(
  doc: Pick<QueueDocument, "settings" | "lastLaunchAt" | "tasks">,
  metrics: QueueMetrics,
  resolveReal?: (path: string) => string,
): QueueTask | null {
  if (evaluateQueueGate(doc, metrics, { resolveReal }).status !== "ready") return null;
  const runningKeys = new Set(
    doc.tasks.filter((task) => task.status === "running").map((task) => canonicalProjectKey(task.folder, resolveReal)),
  );
  return doc.tasks.find(
    (task) => task.status === "queued" && !task.hold && !runningKeys.has(canonicalProjectKey(task.folder, resolveReal)),
  ) ?? null;
}

export function resolveQueueFolderInput(raw: string, home: string): string {
  const trimmed = raw.trim();
  let expanded: string;
  if (trimmed === "~") expanded = home || "~";
  else if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) expanded = home ? join(home, trimmed.slice(2)) : trimmed;
  else expanded = trimmed;
  if (expanded === "") return "";
  if (isAbsolute(expanded)) return normalizeQueueFolder(resolve(expanded));
  return normalizeQueueFolder(expanded);
}

function emptyDocument(): QueueDocument {
  return {
    version: 1,
    settings: { ...DEFAULT_QUEUE_SETTINGS },
    lastLaunchAt: null,
    tasks: [],
  };
}

function finiteNonNegInt(value: unknown, fallback: number, min = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  return rounded >= min ? rounded : fallback;
}

function sanitizeSettings(raw: unknown): { value: QueueSettings; changed: boolean } {
  if (!isJsonObject(raw)) return { value: { ...DEFAULT_QUEUE_SETTINGS }, changed: true };
  const paused = typeof raw["paused"] === "boolean" ? raw["paused"] : DEFAULT_QUEUE_SETTINGS.paused;
  const minMemMb = finiteNonNegInt(raw["minMemMb"], DEFAULT_QUEUE_SETTINGS.minMemMb, 0);
  const maxWorking = finiteNonNegInt(raw["maxWorking"], DEFAULT_QUEUE_SETTINGS.maxWorking, 1);
  const cooldownSec = finiteNonNegInt(raw["cooldownSec"], DEFAULT_QUEUE_SETTINGS.cooldownSec, 0);
  const changed =
    raw["paused"] !== paused ||
    raw["minMemMb"] !== minMemMb ||
    raw["maxWorking"] !== maxWorking ||
    raw["cooldownSec"] !== cooldownSec;
  return { value: { paused, minMemMb, maxWorking, cooldownSec }, changed };
}

function optionalIso(value: unknown): { value: string | null; changed: boolean } {
  if (value === undefined || value === null) return { value: null, changed: value === undefined };
  if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Date.parse(value))) {
    return { value: null, changed: true };
  }
  return { value, changed: false };
}

function sanitizeTask(
  raw: unknown,
  home: string,
  nowIso: string,
  usedIds: Set<string>,
): { task: QueueTask; changed: boolean } | null {
  if (!isJsonObject(raw)) return null;
  if (typeof raw["folder"] !== "string" || typeof raw["prompt"] !== "string") return null;
  const folder = resolveQueueFolderInput(raw["folder"], home);
  const prompt = raw["prompt"];
  if (folder === "" || prompt.trim() === "") return null;

  let changed = folder !== raw["folder"];

  let id = typeof raw["id"] === "string" && raw["id"].trim() !== "" ? raw["id"].trim() : "";
  if (!id || usedIds.has(id)) {
    id = randomUUID();
    changed = true;
  }
  usedIds.add(id);

  const rawTitle = typeof raw["title"] === "string" ? raw["title"].trim() : "";
  const title = rawTitle || queueTaskTitleFallback(prompt);
  if (title !== raw["title"]) changed = true;

  const rawAgent = typeof raw["agent"] === "string" ? raw["agent"].trim() : "";
  const agent = VALID_QUEUE_AGENT.test(rawAgent) ? rawAgent : DEFAULT_QUEUE_AGENT;
  if (agent !== raw["agent"]) changed = true;

  const hold = typeof raw["hold"] === "boolean" ? raw["hold"] : false;
  if (raw["hold"] !== hold) changed = true;

  const rawStatus = raw["status"];
  const status: QueueTaskStatus =
    typeof rawStatus === "string" && (QUEUE_TASK_STATUSES as readonly string[]).includes(rawStatus)
      ? (rawStatus as QueueTaskStatus)
      : "queued";
  if (rawStatus !== status) changed = true;

  const terminal = typeof raw["terminal"] === "string" && raw["terminal"].trim() !== "" ? raw["terminal"].trim() : null;
  if (raw["terminal"] !== terminal) changed = true;

  const createdRaw = typeof raw["createdAt"] === "string" && Number.isFinite(Date.parse(raw["createdAt"]))
    ? raw["createdAt"]
    : nowIso;
  if (raw["createdAt"] !== createdRaw) changed = true;

  const started = optionalIso(raw["startedAt"]);
  const finished = optionalIso(raw["finishedAt"]);
  const error = typeof raw["error"] === "string" && raw["error"] !== "" ? raw["error"] : null;
  if (started.changed || finished.changed || raw["error"] !== error) changed = true;

  return {
    task: {
      id,
      folder,
      title,
      prompt,
      agent,
      hold,
      status,
      terminal,
      createdAt: createdRaw,
      startedAt: started.value,
      finishedAt: finished.value,
      error,
    },
    changed,
  };
}

function sanitizeDocument(
  raw: unknown,
  home: string,
  nowIso: string,
): { doc: QueueDocument; normalized: boolean } | null {
  if (!isJsonObject(raw)) return null;
  if ("tasks" in raw && raw["tasks"] !== undefined && !Array.isArray(raw["tasks"])) return null;

  let normalized = raw["version"] !== 1;
  const settings = sanitizeSettings(raw["settings"]);
  if (settings.changed) normalized = true;

  const lastLaunch = optionalIso(raw["lastLaunchAt"]);
  if (lastLaunch.changed) normalized = true;

  const usedIds = new Set<string>();
  const tasks: QueueTask[] = [];
  for (const entry of Array.isArray(raw["tasks"]) ? raw["tasks"] : []) {
    const clean = sanitizeTask(entry, home, nowIso, usedIds);
    if (!clean) {
      normalized = true;
      continue;
    }
    if (clean.changed) normalized = true;
    tasks.push(clean.task);
  }

  return {
    doc: {
      version: 1,
      settings: settings.value,
      lastLaunchAt: lastLaunch.value,
      tasks,
    },
    normalized,
  };
}

function statSignature(path: string): string | null {
  const info = statSync(path, { throwIfNoEntry: false });
  if (!info || !info.isFile()) return null;
  return `${info.ino}:${info.mtimeMs}:${info.size}`;
}

export class AgentQueueStore {
  readonly filePath: string;
  private readonly home: () => string;
  private readonly now: () => number;
  private doc: QueueDocument = emptyDocument();
  private lastSignature: string | null = null;
  private malformedOnDisk = false;
  private readonly listeners = new Set<(doc: QueueDocument) => void>();

  constructor(stateDir: string, options: { home?: () => string; now?: () => number } = {}) {
    this.filePath = join(stateDir, QUEUE_FILE_NAME);
    this.home = options.home ?? (() => userHome());
    this.now = options.now ?? (() => Date.now());
    this.syncIfChanged(false);
  }

  /** Returns a deep copy of the current document without mutating it. */
  getDocument(): QueueDocument {
    return structuredClone(this.doc);
  }

  subscribe(listener: (doc: QueueDocument) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Re-reads `<stateDir>/agent-queue.json` if its mtime, size, or inode changed since the last read.
   * Preserves in-memory state if a hand-edit left invalid JSON on disk; writes back once if
   * normalization filled in defaults (missing `id`, `createdAt`, etc.) on a hand-edited task.
   */
  syncIfChanged(notify = true): { changed: boolean } {
    const sig = statSignature(this.filePath);
    if (sig === this.lastSignature) return { changed: false };

    if (sig === null) {
      const hadData = this.lastSignature !== null && (this.doc.tasks.length > 0 || this.doc.lastLaunchAt !== null);
      this.lastSignature = null;
      this.malformedOnDisk = false;
      this.doc = emptyDocument();
      if (hadData && notify) this.emit();
      return { changed: hadData };
    }

    let rawText: string;
    try {
      rawText = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.lastSignature = null;
        this.malformedOnDisk = false;
        this.doc = emptyDocument();
        return { changed: false };
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      this.lastSignature = sig;
      this.malformedOnDisk = true;
      console.error(`${this.filePath} is not valid JSON; keeping prior queue state until repaired`);
      return { changed: false };
    }

    const sanitized = sanitizeDocument(parsed, this.home(), new Date(this.now()).toISOString());
    if (!sanitized) {
      this.lastSignature = sig;
      this.malformedOnDisk = true;
      console.error(`${this.filePath} has invalid root shape; keeping prior queue state until repaired`);
      return { changed: false };
    }

    this.malformedOnDisk = false;
    const prevJson = JSON.stringify(this.doc);
    const nextJson = JSON.stringify(sanitized.doc);
    this.doc = sanitized.doc;
    this.lastSignature = sig;

    if (sanitized.normalized) {
      try {
        this.persist(false);
      } catch (error) {
        console.error(`Failed to write normalized ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const changed = prevJson !== nextJson;
    if (changed && notify) this.emit();
    return { changed };
  }

  createTask(input: QueueCreateTaskRequest): QueueTask {
    this.syncIfChanged(false);
    const folder = this.validateFolder(input.folder);
    const prompt = this.validatePrompt(input.prompt);
    const agent = this.validateAgent(input.agent ?? DEFAULT_QUEUE_AGENT);
    const title = this.validateTitle(input.title, prompt);
    const hold = Boolean(input.hold);

    const task: QueueTask = {
      id: randomUUID(),
      folder,
      title,
      prompt,
      agent,
      hold,
      status: "queued",
      terminal: null,
      createdAt: new Date(this.now()).toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
    };

    this.doc.tasks.push(task);
    this.persist();
    this.emit();
    return structuredClone(task);
  }

  updateTask(id: string, patch: QueueUpdateTaskRequest): QueueTask {
    this.syncIfChanged(false);
    const index = this.doc.tasks.findIndex((task) => task.id === id);
    if (index < 0) throw new QueueNotFoundError(id);
    const current = this.doc.tasks[index]!;

    if (current.status === "running") {
      if (patch.folder !== undefined || patch.prompt !== undefined || patch.agent !== undefined) {
        throw new QueueConflictError("task_running", "Cannot edit a running task's folder, prompt, or agent");
      }
      if (patch.status === "queued") {
        throw new QueueConflictError("task_running", "Cannot requeue a task while it is running");
      }
    }

    const folder = patch.folder !== undefined ? this.validateFolder(patch.folder) : current.folder;
    const prompt = patch.prompt !== undefined ? this.validatePrompt(patch.prompt) : current.prompt;
    const agent = patch.agent !== undefined ? this.validateAgent(patch.agent) : current.agent;
    const title = patch.title !== undefined ? this.validateTitle(patch.title, prompt) : current.title;
    const hold = patch.hold !== undefined ? Boolean(patch.hold) : current.hold;

    let next: QueueTask = {
      ...current,
      folder,
      prompt,
      agent,
      title,
      hold,
    };

    if (patch.status === "queued" && current.status !== "queued") {
      next = {
        ...next,
        status: "queued",
        terminal: null,
        startedAt: null,
        finishedAt: null,
        error: null,
      };
    }

    this.doc.tasks[index] = next;
    this.persist();
    this.emit();
    return structuredClone(next);
  }

  deleteTask(id: string): void {
    this.syncIfChanged(false);
    const index = this.doc.tasks.findIndex((task) => task.id === id);
    if (index < 0) throw new QueueNotFoundError(id);
    if (this.doc.tasks[index]!.status === "running") {
      throw new QueueConflictError("task_running", "Cannot delete a running task");
    }
    this.doc.tasks.splice(index, 1);
    this.persist();
    this.emit();
  }

  reorder(input: QueueReorderRequest, resolveReal?: (path: string) => string): QueueTask[] {
    this.syncIfChanged(false);

    if ("id" in input) {
      const targetIndex = this.doc.tasks.findIndex((task) => task.id === input.id);
      if (targetIndex < 0) throw new QueueNotFoundError(input.id);
      if (input.direction !== "up" && input.direction !== "down") {
        throw new QueueValidationError("invalid_direction", "direction must be up or down");
      }
      const targetKey = canonicalProjectKey(this.doc.tasks[targetIndex]!.folder, resolveReal);
      const folderIndices: number[] = [];
      this.doc.tasks.forEach((task, idx) => {
        if (canonicalProjectKey(task.folder, resolveReal) === targetKey) folderIndices.push(idx);
      });
      const pos = folderIndices.indexOf(targetIndex);
      const swapPos = input.direction === "up" ? pos - 1 : pos + 1;
      if (swapPos < 0 || swapPos >= folderIndices.length) return structuredClone(this.doc.tasks);
      const a = folderIndices[pos]!;
      const b = folderIndices[swapPos]!;
      const tmp = this.doc.tasks[a]!;
      this.doc.tasks[a] = this.doc.tasks[b]!;
      this.doc.tasks[b] = tmp;
      this.persist();
      this.emit();
      return structuredClone(this.doc.tasks);
    }

    if (typeof input.folder !== "string" || input.folder.trim() === "" || !Array.isArray(input.orderedIds)) {
      throw new QueueValidationError("invalid_reorder", "folder and orderedIds are required");
    }
    const targetFolder = this.validateFolder(input.folder);
    const targetKey = canonicalProjectKey(targetFolder, resolveReal);
    const folderIndices: number[] = [];
    const byId = new Map<string, QueueTask>();
    this.doc.tasks.forEach((task, idx) => {
      if (canonicalProjectKey(task.folder, resolveReal) === targetKey) {
        folderIndices.push(idx);
        byId.set(task.id, task);
      }
    });

    const placed: QueueTask[] = [];
    const seen = new Set<string>();
    for (const id of input.orderedIds) {
      if (typeof id !== "string") continue;
      const task = byId.get(id);
      if (!task || seen.has(id)) {
        throw new QueueValidationError("invalid_reorder", `Task ${id} does not belong to folder ${targetFolder}`);
      }
      seen.add(id);
      placed.push(task);
    }
    // Preserve any concurrent task in the same folder omitted from orderedIds.
    for (const idx of folderIndices) {
      const task = this.doc.tasks[idx]!;
      if (!seen.has(task.id)) placed.push(task);
    }

    folderIndices.forEach((idx, offset) => {
      this.doc.tasks[idx] = placed[offset]!;
    });

    this.persist();
    this.emit();
    return structuredClone(this.doc.tasks);
  }

  updateSettings(patch: QueueUpdateSettingsRequest): QueueSettings {
    this.syncIfChanged(false);
    const next = { ...this.doc.settings };

    if (patch.paused !== undefined) {
      if (typeof patch.paused !== "boolean") throw new QueueValidationError("invalid_settings", "paused must be a boolean");
      next.paused = patch.paused;
    }
    if (patch.minMemMb !== undefined) {
      if (typeof patch.minMemMb !== "number" || !Number.isFinite(patch.minMemMb) || patch.minMemMb < 0) {
        throw new QueueValidationError("invalid_settings", "minMemMb must be a non-negative number");
      }
      next.minMemMb = Math.round(patch.minMemMb);
    }
    if (patch.maxWorking !== undefined) {
      if (typeof patch.maxWorking !== "number" || !Number.isFinite(patch.maxWorking) || patch.maxWorking < 1) {
        throw new QueueValidationError("invalid_settings", "maxWorking must be an integer >= 1");
      }
      next.maxWorking = Math.round(patch.maxWorking);
    }
    if (patch.cooldownSec !== undefined) {
      if (typeof patch.cooldownSec !== "number" || !Number.isFinite(patch.cooldownSec) || patch.cooldownSec < 0) {
        throw new QueueValidationError("invalid_settings", "cooldownSec must be a non-negative number");
      }
      next.cooldownSec = Math.round(patch.cooldownSec);
    }

    this.doc.settings = next;
    this.persist();
    this.emit();
    return { ...this.doc.settings };
  }

  markTaskRunning(id: string, terminal: string | null, atIso = new Date(this.now()).toISOString()): QueueTask {
    const task = this.requireTask(id);
    const next: QueueTask = {
      ...task,
      status: "running",
      terminal,
      startedAt: task.startedAt ?? atIso,
      finishedAt: null,
      error: null,
    };
    this.doc.lastLaunchAt = atIso;
    this.replaceTask(next);
    return structuredClone(next);
  }

  setTaskTerminal(id: string, terminal: string): QueueTask {
    const task = this.requireTask(id);
    const next: QueueTask = { ...task, terminal };
    this.replaceTask(next);
    return structuredClone(next);
  }

  markTaskDone(id: string, atIso = new Date(this.now()).toISOString()): QueueTask {
    const task = this.requireTask(id);
    const next: QueueTask = {
      ...task,
      status: "done",
      finishedAt: atIso,
      error: null,
    };
    this.replaceTask(next);
    return structuredClone(next);
  }

  markTaskFailed(id: string, reason: string, terminal?: string | null, atIso = new Date(this.now()).toISOString()): QueueTask {
    const task = this.requireTask(id);
    const next: QueueTask = {
      ...task,
      status: "failed",
      terminal: terminal === undefined ? task.terminal : terminal,
      finishedAt: atIso,
      error: reason.trim() || "Task failed",
    };
    this.replaceTask(next);
    return structuredClone(next);
  }

  recordLaunchTimestamp(atIso = new Date(this.now()).toISOString()): void {
    this.doc.lastLaunchAt = atIso;
    this.persist();
    this.emit();
  }

  private requireTask(id: string): QueueTask {
    const found = this.doc.tasks.find((task) => task.id === id);
    if (!found) throw new QueueNotFoundError(id);
    return found;
  }

  private replaceTask(next: QueueTask): void {
    const idx = this.doc.tasks.findIndex((task) => task.id === next.id);
    if (idx < 0) throw new QueueNotFoundError(next.id);
    this.doc.tasks[idx] = next;
    this.persist();
    this.emit();
  }

  private validateFolder(raw: unknown): string {
    if (typeof raw !== "string") throw new QueueValidationError("invalid_folder", "folder must be a string");
    const resolved = resolveQueueFolderInput(raw, this.home());
    if (resolved === "") throw new QueueValidationError("invalid_folder", "folder is required");
    return resolved;
  }

  private validatePrompt(raw: unknown): string {
    if (typeof raw !== "string") throw new QueueValidationError("invalid_prompt", "prompt must be a string");
    const fault = firstMessageFault(raw, true);
    if (fault !== null) throw new QueueValidationError("invalid_prompt", fault.replace("first_message", "prompt"));
    return raw;
  }

  private validateAgent(raw: unknown): string {
    if (typeof raw !== "string") throw new QueueValidationError("invalid_agent", "agent must be a string");
    const trimmed = raw.trim();
    if (!VALID_QUEUE_AGENT.test(trimmed)) {
      throw new QueueValidationError("invalid_agent", "agent must be a lowercase agent id such as claude or codex");
    }
    return trimmed;
  }

  private validateTitle(raw: unknown, prompt: string): string {
    if (raw !== undefined && typeof raw !== "string") {
      throw new QueueValidationError("invalid_title", "title must be a string");
    }
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    return trimmed || queueTaskTitleFallback(prompt);
  }

  private persist(keepDamagedIfMalformed = true): void {
    const keepDamaged = keepDamagedIfMalformed && this.malformedOnDisk;
    if (keepDamaged) {
      console.error(`Keeping malformed ${this.filePath} as ${damagedCopy(this.filePath)}`);
    }
    const json = `${JSON.stringify(this.doc, null, 2)}\n`;
    writeStateDocument(this.filePath, json, keepDamaged);
    this.malformedOnDisk = false;
    this.lastSignature = statSignature(this.filePath);
  }

  private emit(): void {
    const copy = this.getDocument();
    for (const listener of [...this.listeners]) {
      listener(structuredClone(copy));
    }
  }
}
