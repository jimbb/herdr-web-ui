import { constants, closeSync, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import type { PaneProcessInfoProcess } from "../shared/herdr-api.generated.ts";
import { agentGet, paneProcessInfo } from "./herdr/client.ts";
import { transcriptInStore as cmdTranscriptInStore, unwrittenSession } from "./transcript-store.ts";
export { transcriptInStore as cmdTranscriptInStore, unwrittenSession } from "./transcript-store.ts";

/**
 * Command Code's session store. One directory per project (the cwd), under
 * `~/.commandcode/projects/<slug>`, where `<slug>` is the cwd with its leading
 * slash dropped and every other slash turned into a dash, lowercased.
 */
export function cmdSlug(cwd: string): string {
  return cwd.replace(/^[/\\]+/, "").replace(/[/\\]/g, "-").toLowerCase();
}

export function defaultCmdHome(): string {
  return join(homedir(), ".commandcode");
}

export function defaultCmdProjectDir(cwd: string): string {
  return join(defaultCmdHome(), "projects", cmdSlug(cwd));
}

/** Where the commandcode provider's cached catalog lives: the file pi reads the same models from. */
export function cmdModelCatalogPath(): string {
  return join(homedir(), ".pi", "agent", "commandcode-models.json");
}

/** Where integrations/cmd-session.ts names each Command Code process's session, under the Command Code home. */
const CMD_SESSION_DIRECTORY = "ovis";

type CmdTranscriptOptions = {
  agent?: Awaited<ReturnType<typeof agentGet>> | null;
  processes?: readonly PaneProcessInfoProcess[];
};

/**
 * The session the web UI's Command Code mod (integrations/cmd-session.ts) names for the pane's one
 * Command Code process: `~/.commandcode/ovis/<pid>.json`, written by that very pid.
 */
async function modSessionId(paneId: string, processes?: readonly PaneProcessInfoProcess[]): Promise<string | null> {
  const list = processes ?? (await paneProcessInfo(paneId).catch(() => undefined))?.foreground_processes ?? [];
  const cmds = list.filter((entry) => entry.name === "command-code");
  const pid = cmds.length === 1 ? cmds[0]!.pid : null;
  if (typeof pid !== "number") return null;
  const text = readCatalog(join(defaultCmdHome(), CMD_SESSION_DIRECTORY, `${pid}.json`));
  let binding: { pid?: unknown; sessionId?: unknown };
  try { binding = JSON.parse(text ?? "null") ?? {}; } catch { return null; }
  // No process start time is checked (gjc-runtime does): a crashed cmd's file names its session to a
  // new cmd that reuses the pid, until the new one starts its own session and rewrites it.
  return binding.pid === pid && typeof binding.sessionId === "string" && /^[\w-]+$/.test(binding.sessionId) ? binding.sessionId : null;
}

export async function cmdTranscriptPath(
  paneId: string,
  options: CmdTranscriptOptions = {},
): Promise<{ path: string } | { unwritten: { id: string; path: string } } | null> {
  const agent = options.agent === undefined ? await agentGet(paneId).catch(() => null) : options.agent;
  if (agent?.agent !== "cmd") return null;

  // herdr's report names the session, as for pi; no released herdr keeps the one Command Code
  // sends, so without one the web UI's mod names it for the pane's own process. The process
  // environment's COMMANDCODE_SESSION_ID is set at start-up or inherited, so after /clear, /resume
  // or in a child it names another session: shown as this pane's, another conversation would be read.
  const session = agent.agent_session;
  const absent = session === undefined || session === null;
  const reported = (session?.agent === "cmd" && session.source === "herdr:cmd" && session.kind === "path"
    && typeof session.value === "string") ? session.value : null;
  const id = absent ? await modSessionId(paneId, options.processes) : null;
  if (reported === null && id === null) return null;
  // foreground_cwd can belong to a helper when herdr cannot read the group leader's cwd.
  // Each cwd is only a store candidate; the reported session must validate inside it. A mod's id
  // names a file in every store, so a written one anywhere wins before any store calls it unwritten.
  const stores = [...new Set([agent.foreground_cwd, agent.cwd])]
    .filter((cwd): cwd is string => typeof cwd === "string" && cwd.length > 0)
    .map((cwd) => defaultCmdProjectDir(cwd))
    .map((projectDir) => ({ projectDir, candidate: reported ?? join(projectDir, `${id}.jsonl`) }));
  for (const { projectDir, candidate } of stores) {
    const path = cmdTranscriptInStore(candidate, projectDir);
    if (path !== null) return { path };
  }
  for (const { projectDir, candidate } of stores) {
    const unwritten = unwrittenSession(candidate, projectDir);
    if (unwritten !== null) return { unwritten };
  }
  return null;
}

/**
 * Command Code's context window for a model: read from the commandcode provider's
 * cached catalog. On `main` pi-models only consults models.json, which never
 * names commandcode's models, so cmd resolves its own window here.
 */
let cmdCatalogCache: { path: string; mtimeMs: number; windows: Map<string, number> } | null = null;

const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

/** The catalog's text, read only as a regular file of bounded size: a FIFO there must not block the server. */
function readCatalog(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    return stat.isFile() && stat.size <= MAX_CATALOG_BYTES ? readFileSync(fd, "utf8") : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function cmdContextWindow(model: string, catalogPath = cmdModelCatalogPath()): number | null {
  let mtimeMs: number;
  try { mtimeMs = statSync(catalogPath).mtimeMs; } catch { return null; }
  if (cmdCatalogCache === null || cmdCatalogCache.path !== catalogPath || cmdCatalogCache.mtimeMs !== mtimeMs) {
    const text = readCatalog(catalogPath);
    if (text === null) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { return null; }
    const windows = new Map<string, number>();
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as { models?: unknown };
      if (Array.isArray(record.models)) {
        for (const value of record.models) {
          if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
          const entry = value as { id?: unknown; contextWindow?: unknown };
          if (typeof entry.id !== "string") continue;
          const window = entry.contextWindow;
          if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) continue;
          windows.set(entry.id, window);
        }
      }
    }
    cmdCatalogCache = { path: catalogPath, mtimeMs, windows };
  }
  return cmdCatalogCache.windows.get(model) ?? null;
}
