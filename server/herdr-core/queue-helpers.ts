import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { queueFolderName } from "../../shared/agent-queue.ts";
import { MAX_LABEL_CHARS } from "../../shared/labels.ts";
import { displayWidth, secretPrompt } from "../../shared/secret-prompt.ts";
import { canonicalProjectKey } from "../agent-queue-store.ts";
import { claudeRewindOpen } from "../claude-input.ts";
import { stoppedAgentJob } from "../conversation.ts";
import { codexOwnScreenOpen } from "../dialogs/codex.ts";
import { agentPickerWaits, registry } from "../dialogs/registry.ts";
import { paneProcessInfo, paneRead, sessionSnapshot, tabCreate, workspaceCreate } from "../herdr/client.ts";
import { parseInteractivePrompt } from "../prompt.ts";
import type { HcConnection } from "./connection.ts";
import { coreConnection, coreTerminalEnv } from "./runtime.ts";
import {
  agentOf,
  coreHost,
  isRecord,
  LAYOUT_DOC,
  onOtherMachine,
  OTHER_WORKSPACE_ID,
  SEEN_LABEL,
  shownStatusOf,
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

const SHELL_NAME_RE = /(?:^|\/)-?(?:sh|bash|dash|zsh|fish|ksh|mksh|csh|tcsh|ash|nu)$/u;

export interface QueuePaneProbeDeps {
  paneProcessInfo?: typeof paneProcessInfo;
  paneRead?: typeof paneRead;
  stoppedAgentJob?: typeof stoppedAgentJob;
  platform?: NodeJS.Platform;
}

function shellAlone(info: Awaited<ReturnType<typeof paneProcessInfo>> | null): info is NonNullable<Awaited<ReturnType<typeof paneProcessInfo>>> & { shell_pid: number } {
  if (!info || info.shell_pid == null) return false;
  const fg = info.foreground_processes;
  if (!fg || fg.length !== 1) return false;
  const front = fg[0]!;
  if (front.pid !== info.shell_pid) return false;
  return SHELL_NAME_RE.test(front.name) && SHELL_NAME_RE.test(front.argv?.[0] ?? front.argv0 ?? front.name);
}

/**
 * Returns `true` only with positive proof that the launched agent exited back to a live shell
 * (excluding Ctrl+Z suspended jobs and racey foreground transitions). Fail-closed (`false`) on
 * errors, remote machines, Windows, or ambiguous states.
 */
export async function isQueuePaneAgentExited(
  terminal: HcTerminal,
  expectedAgent: string,
  deps: QueuePaneProbeDeps = {},
): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  if (terminal.state !== "live" || onOtherMachine(terminal.address) || platform === "win32") return false;
  if (terminal.foreground && terminal.pid != null && terminal.foreground.pid !== terminal.pid) return false;

  const readProcessInfo = deps.paneProcessInfo ?? paneProcessInfo;
  const stoppedJob = deps.stoppedAgentJob ?? stoppedAgentJob;
  try {
    const first = await readProcessInfo(terminal.address);
    if (!shellAlone(first)) return false;
    if (await stoppedJob(first.shell_pid, expectedAgent)) return false;
    const second = await readProcessInfo(terminal.address);
    return shellAlone(second) && second.shell_pid === first.shell_pid;
  } catch {
    return false;
  }
}

function maskedPromptAtAnyWidthLocal(screen: string): boolean {
  const rows = screen.split(/\r?\n/u);
  while (rows.length > 0 && !rows.at(-1)!.trim()) rows.pop();
  const above = displayWidth(rows.at(-2)?.trimEnd() ?? "");
  return [Infinity, ...(above > 0 ? [above, above + 1] : [])].some((columns) => secretPrompt(screen, columns) !== null);
}

/**
 * Returns `true` when `terminal` is waiting on user input (OSC 7501 `blocked`, interactive menu/trust
 * dialog, picker, Codex own screen, Claude rewind dialog, or masked secret prompt). Fail-closed (`false`)
 * on RPC read errors.
 */
export async function isQueuePaneDialogBlocked(
  terminal: HcTerminal,
  expectedAgent?: string | null,
  deps: QueuePaneProbeDeps = {},
): Promise<boolean> {
  if (terminal.state !== "live" || onOtherMachine(terminal.address)) return false;
  if (shownStatusOf(terminal.status, terminal.turn, terminal.labels) === "blocked") return true;

  const readScreen = deps.paneRead ?? paneRead;
  try {
    const { text: screen } = await readScreen({ paneId: terminal.address, source: "detection", format: "text" });
    if (maskedPromptAtAnyWidthLocal(screen)) return true;
    const agent = agentOf(terminal, coreHost(false, deps.platform ?? process.platform)) ?? expectedAgent ?? null;
    if (agent === null) return false;
    if (agent === "claude" && claudeRewindOpen(screen)) return true;
    if (agent === "codex" && codexOwnScreenOpen(screen)) return true;
    if (agentPickerWaits(agent, screen) || registry.waits(agent, screen)) return true;
    return parseInteractivePrompt(agent, screen, null, true, [], null) !== null;
  } catch {
    return false;
  }
}
