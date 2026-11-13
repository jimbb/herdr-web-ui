import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PaneProcessInfoProcess } from "../shared/herdr-api.generated.ts";
import { programName } from "./agent-identity.ts";
import { paneProcessInfo } from "./herdr/client.ts";
import { transcriptInStore, unwrittenSession } from "./transcript-store.ts";
import { userHome } from "./user-home.ts";

/**
 * Caveman Code (`caveman-code`, a pi 0.65 fork: pi's v3 session JSONL) keeps its agent directory at
 * `~/.cave/agent`, its sessions under `sessions/`. The web UI's extension (integrations/caveman-code.ts)
 * reports it to herdr as the custom agent `caveman-code`; herdr keeps no session for a custom source,
 * so the extension also writes `~/.cave/agent/ovis/<pid>.json` = {pid, sessionFile}, which names the
 * session of the pane's one caveman-code process.
 */
export const cavemanAgentDir = (home = userHome()): string => join(home, ".cave", "agent");

const CAVEMAN_ENTRY = /(^|[\\/])node_modules[\\/]@juliusbrussee[\\/]caveman-code[\\/]dist[\\/]cli\.js$/;

/**
 * A running caveman-code: it renames its process `caveman-code` (process.title) as it starts, so herdr lists
 * that; before then, node running its npm bin or package entry. Its `caveman` bin is not enough: the Caveman
 * CLI (@caveman-ai/cli) installs a `caveman` too.
 */
export function isCavemanProcess(argv: readonly string[]): boolean {
  return programName(argv[0] ?? "") === "caveman-code"
    || ["node", "bun"].includes(programName(argv[0] ?? "")) && (programName(argv[1] ?? "") === "caveman-code" || CAVEMAN_ENTRY.test(argv[1] ?? ""));
}

export async function cavemanTranscriptPath(
  paneId: string,
  processes?: readonly PaneProcessInfoProcess[],
  home = userHome(),
): Promise<{ path: string } | { unwritten: { id: string; path: string } } | null> {
  const list = processes ?? (await paneProcessInfo(paneId).catch(() => undefined))?.foreground_processes ?? [];
  const cavemen = list.filter((entry) => entry.name === "caveman-code" || isCavemanProcess(entry.argv ?? []));
  const pid = cavemen.length === 1 ? cavemen[0]!.pid : null;
  if (typeof pid !== "number") return null;
  let binding: { pid?: unknown; sessionFile?: unknown };
  try { binding = JSON.parse(readFileSync(join(cavemanAgentDir(home), "ovis", `${pid}.json`), "utf8")) ?? {}; } catch { return null; }
  // ponytail: no process start time check, so a reused pid reads a crashed caveman's session until the new one writes its own
  if (binding.pid !== pid || typeof binding.sessionFile !== "string") return null;
  const store = join(cavemanAgentDir(home), "sessions");
  const path = transcriptInStore(binding.sessionFile, store);
  if (path !== null) return { path };
  const unwritten = unwrittenSession(binding.sessionFile, store);
  return unwritten === null ? null : { unwritten };
}
