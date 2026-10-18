/**
 * kiro-cli's native session transcript, read as one append-only JSONL file.
 *
 * kiro-cli (Amazon's Kiro CLI) writes a session per conversation under
 * `~/.kiro/sessions/cli/<uuid>.jsonl`, with a `<uuid>.json` sidecar holding
 * session metadata (cwd, title, timestamps). Each JSONL line is an envelope
 * `{ version, kind, data }` where `kind` is one of:
 *   - "Prompt"           a user turn:   data.content = [{kind:"text", data}], data.meta.timestamp (epoch seconds)
 *   - "AssistantMessage" an assistant:  data.content = [{kind:"thinking"|"text"|"toolUse", data}]
 *   - "ToolResults"      tool outputs:  data.content = [{kind:"toolResult", data:{toolUseId, content}}],
 *                                        data.results = { <toolUseId>: {tool:{tool_use_purpose,…}, result:{Success|Error}} }
 *
 * The records are self-contained and append-only, so — unlike Grok/Agy — kiro
 * needs no byte-offset projection: the shared pager streams the whole file and
 * parseKiroTranscript folds it into turns. Reasoning blocks are stored
 * encrypted (`thinking.data.redactedContent`); we surface a folded marker, never
 * a guess at their text.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import { agentGet } from "./herdr/client.ts";
import { toolSummary } from "./transcript-records.ts";
import { trimOutput } from "./tool-output.ts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** `KIRO_SESSION_DIR` overrides the default store (tests, non-default installs). */
export function defaultKiroSessionDir(): string {
  const override = process.env["KIRO_SESSION_DIR"];
  if (override && override.length > 0) return override;
  return join(process.env["HOME"] ?? "", ".kiro", "sessions", "cli");
}

/** A path is kiro's own only when it resolves to a `.jsonl` regular file inside the store. */
export function kiroTranscriptInStore(value: string, sessionDir = defaultKiroSessionDir()): string | null {
  if (!value) return null;
  let store: string;
  let path: string;
  try {
    store = realpathSync(sessionDir);
    path = realpathSync(resolve(value));
  } catch {
    return null;
  }
  if (path !== store && !path.startsWith(store + sep)) return null;
  if (!path.endsWith(".jsonl")) return null;
  try {
    if (!statSync(path).isFile()) return null;
  } catch {
    return null;
  }
  return path;
}

/** A named-but-not-yet-written session: the `.jsonl` does not exist, but its id is inside the store. */
export function unwrittenKiroSession(
  value: string,
  sessionDir = defaultKiroSessionDir(),
): { id: string; path: string } | null {
  if (!value || !value.endsWith(".jsonl")) return null;
  let store: string;
  let path: string;
  try {
    store = realpathSync(sessionDir);
  } catch {
    return null;
  }
  path = resolve(value);
  // the file is absent, so only its intended location is checked against the store
  if (path !== store && !path.startsWith(store + sep)) return null;
  try {
    statSync(path);
    return null; // it exists — not unwritten
  } catch {
    const id = path.slice(path.lastIndexOf(sep) + 1, -".jsonl".length);
    return id ? { id, path } : null;
  }
}

/** Options let tests inject the herdr agent record instead of calling the bridge. */
export interface KiroTranscriptOptions {
  agent?: Awaited<ReturnType<typeof agentGet>> | null;
}

/**
 * The kiro session jsonl for a pane, from herdr's `agent.get` (via the typed
 * `agentGet` wrapper). herdr reports the session as `{ kind: "path", value: <abs
 * .jsonl> }` once kiro-cli names it; an id-only report, a non-kiro agent, or a
 * path outside the store is treated as no session.
 */
export async function kiroTranscriptPath(
  paneId: string,
  sessionDir = defaultKiroSessionDir(),
  options: KiroTranscriptOptions = {},
): Promise<{ path: string } | { unwritten: { id: string; path: string } } | null> {
  const agent = options.agent === undefined ? await agentGet(paneId).catch(() => null) : options.agent;
  const session = agent?.agent_session;
  if (agent?.agent !== "kiro" || session?.agent !== "kiro" || session.kind !== "path" || typeof session.value !== "string") {
    return null;
  }
  const path = kiroTranscriptInStore(session.value, sessionDir);
  if (path !== null) return { path };
  const unwritten = unwrittenKiroSession(session.value, sessionDir);
  return unwritten === null ? null : { unwritten };
}

/** Milliseconds a clear winner must lead the runner-up by to be chosen unambiguously. */
const AMBIGUITY_MARGIN_MS = 60_000;

interface KiroCandidate {
  path: string;
  updatedMs: number;
}

/**
 * Read a session's `<uuid>.json` sidecar and decide whether its `.jsonl` is an
 * interactive session for `cwd`. Subagent sessions and empty/absent transcripts
 * are rejected. Returns the candidate with its last-updated time (sidecar
 * `updated_at`, else the jsonl mtime) for recency ordering.
 */
function sidecarCandidate(sessionDir: string, jsonlName: string, cwd: string): KiroCandidate | null {
  if (!jsonlName.endsWith(".jsonl")) return null;
  const jsonlPath = join(sessionDir, jsonlName);
  let jsonlStat;
  try {
    jsonlStat = statSync(jsonlPath);
  } catch {
    return null;
  }
  if (!jsonlStat.isFile() || jsonlStat.size === 0) return null;

  const sidecarPath = join(sessionDir, jsonlName.slice(0, -".jsonl".length) + ".json");
  let meta: RecordValue = {};
  try {
    meta = record(JSON.parse(readFileSync(sidecarPath, "utf8")));
  } catch {
    // no readable sidecar: fall back to the jsonl's own cwd check below is impossible,
    // so without a sidecar we cannot attribute the session to a cwd — reject it.
    return null;
  }
  if (meta.cwd !== cwd) return null;
  // NOTE: session_created_reason is "subagent" for ~all kiro-cli sessions (including
  // interactive ones), so it is NOT a usable "interactive vs background" signal. Empty
  // transcripts (size 0) are the real throwaway/unstarted stubs and are excluded above.

  const updatedIso = typeof meta.updated_at === "string" ? Date.parse(meta.updated_at) : NaN;
  const updatedMs = Number.isFinite(updatedIso) ? updatedIso : jsonlStat.mtimeMs;
  return { path: jsonlPath, updatedMs };
}

/**
 * Resolve a kiro pane's transcript by cwd when herdr reports no session path.
 * Lists the store's sidecars, keeps interactive sessions whose `cwd` matches the
 * pane's, and returns the most recent — but only when it is an UNAMBIGUOUS
 * winner (the sole candidate, or clearly newer than the next by
 * `AMBIGUITY_MARGIN_MS`). An ambiguous cwd yields null so the pane shows its
 * terminal instead of risking another conversation's chat.
 */
export function kiroTranscriptByCwd(cwd: string, sessionDir = defaultKiroSessionDir()): { path: string } | null {
  if (!cwd) return null;
  let entries: string[];
  try {
    entries = readdirSync(sessionDir);
  } catch {
    return null;
  }
  const candidates: KiroCandidate[] = [];
  for (const name of entries) {
    const candidate = sidecarCandidate(sessionDir, name, cwd);
    if (candidate) candidates.push(candidate);
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.updatedMs - a.updatedMs);
  const [winner, runnerUp] = candidates;
  if (runnerUp && winner!.updatedMs - runnerUp.updatedMs < AMBIGUITY_MARGIN_MS) return null;
  return { path: winner!.path };
}

/**
 * The transcript for a kiro pane. First honors a herdr-reported session path
 * (the clean route, when herdr's kiro integration reports `agent_session`);
 * otherwise falls back to the unambiguous cwd match. `cwd` should be the pane's
 * `foreground_cwd` (the directory kiro-cli actually runs in).
 */
export async function resolveKiroTranscript(
  paneId: string,
  cwd: string,
  sessionDir = defaultKiroSessionDir(),
  options: KiroTranscriptOptions = {},
): Promise<{ path: string } | { unwritten: { id: string; path: string } } | null> {
  const byPath = await kiroTranscriptPath(paneId, sessionDir, options);
  if (byPath !== null) return byPath;
  return kiroTranscriptByCwd(cwd, sessionDir);
}

type Tool = Extract<ConversationPart, { kind: "tool" }>;

/** A kiro content-block array ([{kind:"text", data:"…"}]) to plain text. */
function blocksToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const block of content) {
    const b = record(block);
    if (b.kind === "text" && typeof b.data === "string") out.push(b.data);
    else if (b.kind === "text") {
      const d = record(b.data);
      if (typeof d.text === "string") out.push(d.text);
    } else if (typeof block === "string") out.push(block);
  }
  return out.join("");
}

/** A toolResult's nested content array to flat text. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  const out: string[] = [];
  for (const block of content) {
    const b = record(block);
    if (b.kind === "text" && typeof b.data === "string") out.push(b.data);
    else if (b.kind === "json") out.push(JSON.stringify(b.data));
    else if (typeof block === "string") out.push(block);
    else if ("data" in b) out.push(typeof b.data === "string" ? b.data : JSON.stringify(b.data));
  }
  return out.join("\n");
}

function isoFromEpochSeconds(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const ms = value * 1000;
  if (Math.abs(ms) > 8.64e15) return null;
  return new Date(ms).toISOString();
}

/** The outcome key of a kiro `results[id].result` map: "Success" | "Error" | …; undefined if absent. */
function resultOutcome(rich: RecordValue): string | undefined {
  const result = record(rich.result);
  const keys = Object.keys(result);
  return keys.length > 0 ? keys[0] : undefined;
}

/**
 * Fold a kiro session jsonl into conversation turns. Append-only and
 * self-contained, so one forward pass pairs each ToolResults record to the
 * toolUse it answers by `toolUseId`. `maxTurns` keeps only the last N.
 *
 * Turn boundaries mirror the other agents: kiro-cli records one `AssistantMessage`
 * per model reply step. A step that calls tools is followed by a `ToolResults`
 * record and more steps; a step with NO tool call is the model's final reply and
 * ends the turn — every such step is immediately followed by the next user
 * `Prompt` (or the end of the session). So a tool-less `AssistantMessage` closes
 * the current assistant turn (its trailing text tagged `final_answer`), and the
 * next `AssistantMessage` opens a fresh one. Without this split a whole exchange
 * of several replies would collapse into one turn, folding every earlier answer
 * into a single work block instead of reading as a conversation.
 */
export function parseKiroTranscript(text: string, maxTurns = Infinity): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let current: ConversationTurn | undefined;
  // once a tool-less reply closes the assistant turn, the next AssistantMessage starts a new one
  let turnComplete = false;
  // tool parts awaiting their ToolResults, keyed by toolUseId
  const pending = new Map<string, Tool>();

  const openAssistant = (): ConversationTurn => {
    if (!current || current.role !== "assistant" || turnComplete) {
      current = { role: "assistant", ts: null, parts: [] };
      turns.push(current);
      turnComplete = false;
    }
    return current;
  };

  /** The last non-empty text part of a turn: the model's answer for this reply. */
  const markFinalAnswer = (turn: ConversationTurn): void => {
    for (let i = turn.parts.length - 1; i >= 0; i -= 1) {
      const part = turn.parts[i]!;
      if (part.kind === "text" && part.text.trim()) {
        part.phase = "final_answer";
        return;
      }
    }
  };

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: RecordValue;
    try {
      rec = record(JSON.parse(trimmed));
    } catch {
      continue;
    }
    const kind = rec.kind;
    const data = record(rec.data);

    if (kind === "Prompt") {
      const textValue = blocksToText(data.content);
      const ts = isoFromEpochSeconds(record(data.meta).timestamp);
      // a prompt opens a user turn; tool results for the previous turn have already landed
      current = { role: "user", ts, parts: textValue ? [{ kind: "text", text: textValue }] : [] };
      turns.push(current);
      turnComplete = false;
      pending.clear();
      continue;
    }

    if (kind === "AssistantMessage") {
      const turn = openAssistant();
      const content = Array.isArray(data.content) ? data.content : [];
      let hasToolUse = false;
      for (const block of content) {
        const b = record(block);
        if (b.kind === "text" && typeof b.data === "string" && b.data.trim()) {
          // narration before a tool call is commentary (folded into the work block); the
          // reply's closing text is tagged final_answer below, once we know it calls no tool
          const last = turn.parts.at(-1);
          if (last?.kind === "text" && last.phase !== "final_answer") last.text += b.data;
          else turn.parts.push({ kind: "text", text: b.data });
        } else if (b.kind === "thinking") {
          const d = record(b.data);
          const text = typeof d.text === "string" ? d.text : "";
          // reasoning is stored encrypted (redactedContent); never fabricate its text
          if (text.trim()) turn.parts.push({ kind: "thinking", text });
          else if (Array.isArray(d.redactedContent) && d.redactedContent.length > 0)
            turn.parts.push({ kind: "thinking", text: "[reasoning]" });
        } else if (b.kind === "toolUse") {
          hasToolUse = true;
          const d = record(b.data);
          const id = str(d.toolUseId) || str(d.id);
          const name = str(d.name) || str(d.tool) || "tool";
          const inputValue = d.input ?? d.args ?? {};
          const inputObj = record(inputValue);
          // kiro embeds a human-readable purpose in the call input
          const purpose = str(inputObj["__tool_use_purpose"]);
          const input = typeof inputValue === "string" ? inputValue : JSON.stringify(inputValue);
          const part: Tool = {
            kind: "tool",
            name,
            summary: purpose || toolSummary(name, inputObj),
            input,
            output: "",
          };
          turn.parts.push(part);
          if (id) pending.set(id, part);
        }
      }
      // a reply that called no tool is the model's final answer: tag it and close the turn,
      // so the next AssistantMessage begins the next reply as its own turn
      if (!hasToolUse) {
        markFinalAnswer(turn);
        turnComplete = true;
      }
      continue;
    }

    if (kind === "ToolResults") {
      const turn = openAssistant();
      const content = Array.isArray(data.content) ? data.content : [];
      const results = record(data.results);
      for (const block of content) {
        const b = record(block);
        if (b.kind !== "toolResult") continue;
        const d = record(b.data);
        const id = str(d.toolUseId);
        const outputText = toolResultText(d.content);
        const rich = id ? record(results[id]) : {};
        const outcome = resultOutcome(rich);
        const isError =
          outcome === "Error" ||
          d.status === "error" ||
          d.status === "Error" ||
          (typeof d.status === "string" && d.status.toLowerCase().includes("err"));
        const purpose = str(record(rich.tool)["tool_use_purpose"]);
        const existing = id ? pending.get(id) : undefined;
        const part =
          existing ??
          ({ kind: "tool", name: "tool", summary: "tool result", input: "", output: "" } as Tool);
        if (!existing) turn.parts.push(part);
        if (purpose) part.summary = purpose;
        if (isError) part.error = true;
        trimOutput(part, outputText, `kiro:${id || String(turn.parts.length)}`);
        if (id) pending.delete(id);
      }
      continue;
    }
    // other kinds (metadata, bookkeeping) are not part of the conversation
  }

  return turns.filter((turn) => turn.parts.length > 0).slice(-maxTurns);
}
