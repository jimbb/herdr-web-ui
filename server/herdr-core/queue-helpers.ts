import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { queueFolderName } from "../../shared/agent-queue.ts";
import { MAX_LABEL_CHARS } from "../../shared/labels.ts";
import { canonicalProjectKey } from "../agent-queue-store.ts";
import { agentPrompt, HerdrError, paneGet, sessionSnapshot, tabCreate, workspaceCreate } from "../herdr/client.ts";
import { HcError, type HcConnection } from "./connection.ts";
import { coreConnection, coreTerminalEnv } from "./runtime.ts";
import {
  isRecord,
  LAYOUT_DOC,
  onOtherMachine,
  OTHER_WORKSPACE_ID,
  SEEN_LABEL,
  SPACE_LABEL,
  TAB_LABEL,
  TAB_NAME_LABEL,
  WORKSPACE_NAME_LABEL,
  type HcTerminal,
} from "./snapshot.ts";

/** Trims control newlines/tabs and truncates to `MAX_LABEL_CHARS` UTF-16 code units without splitting surrogates. */
export function truncateTabLabel(title: string, maxChars = MAX_LABEL_CHARS): string {
  const clean = title.replace(/[\r\n\t]+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  let end = maxChars;
  if (end > 0) {
    const tail = clean.charCodeAt(end - 1);
    if (tail >= 0xd800 && tail <= 0xdbff) end -= 1;
  }
  return clean.slice(0, end).trimEnd();
}

/** Reads all terminals reported by the local core (`hc`). */
export async function getCoreTerminals(hc: Pick<HcConnection, "call"> = coreConnection()): Promise<HcTerminal[]> {
  const result = await hc.call("terminal.list", {});
  return result.terminals as HcTerminal[];
}

/** Counts live local-machine core terminals whose reported status is `"working"`. */
export function countCoreWorkingTerminals(terminals: readonly HcTerminal[]): number {
  let count = 0;
  for (const terminal of terminals) {
    if (terminal.state !== "live") continue;
    if (onOtherMachine(terminal.address)) continue;
    if (terminal.status?.state === "working") count += 1;
  }
  return count;
}

export interface OpenQueueTabDeps {
  hc?: Pick<HcConnection, "call">;
  snapshot?: typeof sessionSnapshot;
  tabCreate?: typeof tabCreate;
  workspaceCreate?: typeof workspaceCreate;
  terminalEnv?: () => Promise<Record<string, string>>;
  folderExists?: (path: string) => boolean;
  resolveReal?: (path: string) => string;
}

/**
 * Opens a new tab for a queue task in the project's matching `herdr-app` space or Ovis workspace,
 * or creates a new workspace named after `folder`'s basename when none matches.
 */
export async function openQueueTab(
  folder: string,
  title?: string | null,
  deps: OpenQueueTabDeps = {},
): Promise<string> {
  const folderExists = deps.folderExists ?? defaultFolderExists;
  if (!folderExists(folder)) {
    throw new Error(`Project folder does not exist: ${folder}`);
  }

  const hc = deps.hc ?? coreConnection();
  const readSnapshot = deps.snapshot ?? sessionSnapshot;
  const createTab = deps.tabCreate ?? tabCreate;
  const createWorkspace = deps.workspaceCreate ?? workspaceCreate;
  const getTerminalEnv = deps.terminalEnv ?? coreTerminalEnv;
  const resolveReal = deps.resolveReal;

  const tabLabel = title ? truncateTabLabel(title) : "";
  const targetKey = canonicalProjectKey(folder, resolveReal);

  const [doc, snapshot] = await Promise.all([
    hc.call("doc.get", { name: LAYOUT_DOC }).catch(() => null),
    readSnapshot(),
  ]);

  // 1. Check `herdr-app` spaces first (including empty spaces omitted from sessionSnapshot().workspaces).
  const spaces = isRecord(doc?.value) && Array.isArray(doc.value["spaces"]) ? doc.value["spaces"] : [];
  for (const space of spaces) {
    if (!isRecord(space) || typeof space["id"] !== "string" || space["id"] === "") continue;
    if (typeof space["folder"] !== "string" || space["folder"].trim() === "") continue;
    if (canonicalProjectKey(space["folder"], resolveReal) !== targetKey) continue;

    if (snapshot.workspaces.some((workspace) => workspace.workspace_id === space["id"])) {
      const created = await createTab({
        workspaceId: space["id"],
        cwd: folder,
        ...(tabLabel ? { label: tabLabel } : {}),
      });
      return created.root_pane.pane_id;
    }

    const env = await getTerminalEnv();
    const spaceName =
      typeof space["name"] === "string" && space["name"].trim() !== ""
        ? space["name"].trim()
        : queueFolderName(folder) || folder;
    const run = await hc.call("terminal.run", {
      keep: true,
      cwd: folder,
      labels: {
        [SEEN_LABEL]: "0",
        [SPACE_LABEL]: space["id"],
        [TAB_LABEL]: `ovis-${randomUUID()}`,
        [WORKSPACE_NAME_LABEL]: truncateTabLabel(spaceName) || spaceName,
        ...(tabLabel ? { [TAB_NAME_LABEL]: tabLabel } : {}),
      },
      ...(Object.keys(env).length > 0 ? { env } : {}),
    });
    return run.address;
  }

  // 2. Match existing snapshot workspaces (Ovis-created workspaces or active git worktrees).
  for (const workspace of snapshot.workspaces) {
    if (workspace.workspace_id === OTHER_WORKSPACE_ID) continue;
    const workspaceFolder =
      workspace.worktree?.checkout_path ??
      snapshot.panes.find((pane) => pane.workspace_id === workspace.workspace_id)?.cwd;
    if (!workspaceFolder) continue;
    if (canonicalProjectKey(workspaceFolder, resolveReal) !== targetKey) continue;
    const created = await createTab({
      workspaceId: workspace.workspace_id,
      cwd: folder,
      ...(tabLabel ? { label: tabLabel } : {}),
    });
    return created.root_pane.pane_id;
  }

  // 3. No matching space/workspace found: create a new workspace named after the project folder.
  const workspaceLabel = truncateTabLabel(queueFolderName(folder)) || truncateTabLabel(folder) || "Project";
  const created = await createWorkspace({ cwd: folder, label: workspaceLabel });
  if (tabLabel) {
    await hc.call("terminal.label", {
      terminal: created.root_pane.pane_id,
      labels: { [TAB_NAME_LABEL]: tabLabel },
    }).catch(() => undefined);
  }
  return created.root_pane.pane_id;
}

function defaultFolderExists(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

export interface DeliverQueuePromptDeps {
  hc?: Pick<HcConnection, "call">;
  paneGet?: typeof paneGet;
  sendPrompt?: (paneId: string, text: string) => Promise<void>;
  beforeSend?: () => void;
  onRetry?: () => void;
  timeoutMs?: number;
  pollMs?: number;
  settleMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_PROMPT_CODES = new Set(["agent_blocked", "blocked", "agent_not_ready", "agent_not_found"]);

/**
 * Waits until the launched agent in `paneId` is live and ready (not blocked at a trust prompt or still
 * booting), then submits `text` via `agent.prompt`.
 */
export async function deliverQueuePrompt(
  paneId: string,
  text: string,
  deps: DeliverQueuePromptDeps = {},
): Promise<void> {
  const hc = deps.hc ?? coreConnection();
  const readPane = deps.paneGet ?? paneGet;
  const sendPrompt = deps.sendPrompt ?? ((id, msg) => agentPrompt(id, msg));
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const pollMs = deps.pollMs ?? 250;
  const settleMs = deps.settleMs ?? 1_500;
  const now = deps.now ?? Date.now;

  const start = now();
  const deadline = start + timeoutMs;
  const settleUntil = Math.min(deadline, start + settleMs);
  let lastBlocked = false;
  let lastAgent = false;
  let seenStatus = false;
  let lastRetryError: Error | null = null;

  while (now() < deadline) {
    let terminal: HcTerminal;
    try {
      terminal = await hc.call("terminal.get", { terminal: paneId }) as HcTerminal;
    } catch (error) {
      if ((error instanceof HcError && error.kind === "not_found") || (error instanceof HerdrError && error.code === "pane_not_found")) {
        throw new Error(`Terminal ${paneId} no longer exists`);
      }
      throw error;
    }

    if (terminal.state !== "live") {
      throw new Error(`Terminal ${paneId} ended before prompt delivery`);
    }

    if (terminal.status != null) seenStatus = true;
    const statusState = terminal.status?.state;

    let agentRunning = false;
    try {
      const pane = await readPane(paneId);
      agentRunning = Boolean(pane.agent);
    } catch (error) {
      if (error instanceof HerdrError && error.code === "pane_not_found") {
        throw new Error(`Terminal ${paneId} no longer exists`);
      }
    }

    lastAgent = agentRunning;
    lastBlocked = statusState === "blocked";

    const readyByStatus =
      statusState === "blocked" || statusState === "working"
        ? false
        : seenStatus
          ? true
          : now() >= settleUntil;

    if (agentRunning && readyByStatus) {
      deps.beforeSend?.();
      try {
        await sendPrompt(paneId, text);
        return;
      } catch (error) {
        const code =
          error instanceof HerdrError ? error.code
            : error instanceof HcError ? error.kind
              : "";
        if (RETRYABLE_PROMPT_CODES.has(code)) {
          deps.onRetry?.();
          lastRetryError = error instanceof Error ? error : new Error(String(error));
          if (code === "agent_blocked" || code === "blocked") lastBlocked = true;
        } else {
          throw error;
        }
      }
    }

    if (now() >= deadline) break;
    const waitMs = Math.min(pollMs, Math.max(1, deadline - now()));
    if (deps.sleep) await deps.sleep(waitMs);
    else await Bun.sleep(waitMs);
  }

  if (lastBlocked) {
    throw new Error("Agent is blocked waiting for interactive approval before prompt delivery");
  }
  if (!lastAgent) {
    throw new Error("Agent did not become ready before prompt delivery timed out");
  }
  throw new Error(
    lastRetryError
      ? `Prompt delivery timed out: ${lastRetryError.message}`
      : "Prompt delivery timed out waiting for agent readiness",
  );
}
