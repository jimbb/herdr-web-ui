/**
 * The agent inbox's list (components/InboxList.tsx): every shown PC's agents in one list, the ones
 * that need the reader first, narrowed by state. Built on the Agents list's own rows and shown state
 * (lib/agentRoster.ts, lib/sidebarActivity.tsx), so the two never disagree.
 */
import { normalizeQueueFolder, queueFolderName, type QueueTask } from "../../shared/agent-queue.ts";
import { HC_OTHER_WORKSPACE_ID, LOCAL_MACHINE, type Machine } from "../../shared/machines.ts";
import { parseInline, shownText } from "../../shared/markdown.ts";
import type { AgentStatus, PlanSummary } from "../../shared/protocol.ts";
import { groupQueueTasksByFolder } from "./agentQueue.ts";
import { agentGroup, agentRoster, groupAgentRows, nestRows, type AgentGroup, type AgentRow } from "./agentRoster.ts";
import { fileFromLink, type AppLink } from "./deepLink.ts";
import type { Translate } from "./i18n.ts";
import type { AgentGroupSort, InboxGrouping } from "./settings.ts";
import type { SidebarActivity } from "./sidebarActivity.tsx";
import type { RowSummary } from "./useInboxSummaries.ts";
import { capped } from "./promptText.ts";
import { machineFilter, sidebarFilter } from "./sidebarFilter.ts";
import { sidebarPinKey } from "./sidebarPins.ts";
import { worktreeGroups } from "./workspaceOrder.ts";

/** A resting agent shows only under All. Queued also includes held and failed queue tasks. */
export const INBOX_FILTERS = ["all", "blocked", "working", "queued", "done"] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

/** A row is its PC and its pane: two PCs may reuse a pane id. */
export function inboxKey(row: AgentRow): string {
  return sidebarPinKey(row.machine.id, row.entry.pane.pane_id);
}

function inboxParentKey(row: AgentRow): string | undefined {
  const parent = row.entry.pane.parent_pane_id;
  return parent === undefined ? undefined : sidebarPinKey(row.machine.id, parent);
}

/** The state a row draws, as the Agents list draws it; a PC that is away says none. */
export function inboxStatus(row: AgentRow, activity: SidebarActivity): AgentStatus | undefined {
  return row.machine.state === "connected" ? activity.status(row.machine.id, row.entry.pane) : undefined;
}

/**
 * Every agent row: needs you, working, done, resting; within a state in the order the Agents list grouped by
 * state uses (Settings → Within a state: the longest in that state first by default, each PC's rows apart).
 */
export function inboxOrder(machines: readonly Machine[], activity: SidebarActivity, order?: InboxOrder): AgentRow[] {
  return inboxAgentGroups(inboxRoster(machines, activity), activity, order).flatMap(({ rows }) => rows);
}

type InboxOrder = { sort?: AgentGroupSort; name?: (row: AgentRow) => string };

export function inboxRoster(machines: readonly Machine[], activity: SidebarActivity): AgentRow[] {
  return agentRoster(machines, { byActivity: false, seqs: activity.seqs, pinned: [] }).rest;
}

function inboxAgentGroups(rows: readonly AgentRow[], activity: SidebarActivity, { sort = "wait", name = () => "" }: InboxOrder = {}) {
  return groupAgentRows(rows, { sort, status: (row) => inboxStatus(row, activity), name, seqs: activity.seqs });
}

export interface InboxQueueEntry {
  kind: "queue";
  key: string;
  task: QueueTask;
  position: number | null;
  canStart: boolean;
}

type InboxEntry = InboxQueueEntry | { kind: "agent"; key: string; row: AgentRow };
interface InboxSection { key: string; name: string | null; entries: InboxEntry[] }

/** Positions are from the full folder queue, so filtering a row never renumbers the next one. */
export function inboxQueue(tasks: readonly QueueTask[], agents: readonly AgentRow[]) {
  const localPanes = new Set(agents.filter((row) => row.machine.id === LOCAL_MACHINE).map((row) => row.entry.pane.pane_id));
  const running = new Set<string>();
  const entries: InboxQueueEntry[] = [];
  for (const group of groupQueueTasksByFolder(tasks)) {
    let position = 0;
    for (const task of group.tasks) {
      if (task.status === "queued") position++;
      if (task.terminal !== null && localPanes.has(task.terminal)) {
        if (task.status === "running") running.add(sidebarPinKey(LOCAL_MACHINE, task.terminal));
        continue;
      }
      if (task.status === "queued" || task.status === "failed") {
        entries.push({ kind: "queue", key: `queue:${task.id}`, task, position: task.status === "queued" ? position : null, canStart: task.status === "queued" && group.runningTask === null });
      }
    }
  }
  return { entries, running };
}

export function inboxQueueSearched(entries: readonly InboxQueueEntry[], filter: InboxFilter, query: string): InboxQueueEntry[] {
  if (filter !== "all" && filter !== "queued") return [];
  const typed = query.trim().toLowerCase();
  return entries.filter(({ task }) => task.title.toLowerCase().includes(typed) || task.prompt.toLowerCase().includes(typed));
}

export function inboxSections(rows: readonly AgentRow[], queue: InboxQueueEntry[], machines: readonly Machine[], activity: SidebarActivity, grouping: InboxGrouping, order?: InboxOrder): InboxSection[] {
  const groups = inboxAgentGroups(rows, activity, order);
  const agentEntry = (row: AgentRow): InboxEntry => ({ kind: "agent", key: inboxKey(row), row });
  if (grouping === "state") {
    const urgent = groups.filter(({ group }) => group === "blocked" || group === "working");
    return [{ key: "state", name: null, entries: [...urgent.flatMap(({ rows }) => rows.map(agentEntry)), ...queue, ...groups.slice(urgent.length).flatMap(({ rows }) => rows.map(agentEntry))] }];
  }

  const byWorkspace = new Map<string, InboxSection>();
  const byFolder = new Map<string, InboxSection>();
  const byLabel = new Map<string, InboxSection | null>();
  for (const { id, snapshot } of machines) {
    for (const { workspace, children } of worktreeGroups(snapshot?.workspaces ?? [])) {
      const key = sidebarPinKey(id, workspace.workspace_id);
      const project: InboxSection = { key, name: workspace.label, entries: [] };
      for (const member of [workspace, ...children]) byWorkspace.set(sidebarPinKey(id, member.workspace_id), project);
    }
  }
  const local = machines.find(({ id }) => id === LOCAL_MACHINE)?.snapshot;
  if (local) {
    const firstCwd = new Map<string, string | null | undefined>();
    for (const pane of local.panes) if (!firstCwd.has(pane.workspace_id)) firstCwd.set(pane.workspace_id, pane.cwd);
    // Match the roster in launcher order: checkout path, then the first pane's cwd. Use a label if neither is known.
    for (const workspace of local.workspaces) {
      if (workspace.workspace_id === HC_OTHER_WORKSPACE_ID) continue;
      const project = byWorkspace.get(sidebarPinKey(LOCAL_MACHINE, workspace.workspace_id))!;
      const folder = normalizeQueueFolder(workspace.worktree?.checkout_path ?? firstCwd.get(workspace.workspace_id) ?? "");
      if (folder && !byFolder.has(folder)) byFolder.set(folder, project);
      if (!folder && byLabel.get(workspace.label) !== project) byLabel.set(workspace.label, byLabel.has(workspace.label) ? null : project);
    }
  }

  const projects = new Set<InboxSection>();
  const agentProjects = new Map<string, InboxSection>();
  for (const row of groups.flatMap(({ rows }) => rows)) {
    const { machine, entry: { workspace } } = row;
    const key = inboxKey(row);
    const project = agentProjects.get(inboxParentKey(row) ?? "") ?? byWorkspace.get(sidebarPinKey(machine.id, workspace.workspace_id))!;
    agentProjects.set(key, project);
    project.entries.push(agentEntry(row));
    projects.add(project);
  }
  for (const entry of queue) {
    const folder = normalizeQueueFolder(entry.task.folder);
    const name = queueFolderName(folder);
    const project = byFolder.get(folder) ?? byLabel.get(name) ?? { key: `folder:${folder}`, name, entries: [] };
    byFolder.set(folder, project);
    project.entries.push(entry);
    projects.add(project);
  }
  return [...projects].sort((a, b) => a.name!.localeCompare(b.name!));
}

export function inboxHeldEntries(entries: readonly InboxEntry[], held: readonly string[]): InboxEntry[] {
  return nestRows(heldOrder(entries, (entry) => entry.key, held), (entry) => entry.key, (entry) => entry.kind === "agent" ? inboxParentKey(entry.row) : undefined);
}

/** Depth only follows a parent already drawn in the same section. */
export function inboxNesting(rows: readonly AgentRow[]) {
  const nesting = new Map<string, { depth: number; row: AgentRow; parent?: AgentRow }>();
  for (const row of rows) {
    const parent = nesting.get(inboxParentKey(row) ?? "");
    nesting.set(inboxKey(row), { row, depth: parent ? parent.depth + 1 : 0, parent: parent?.row });
  }
  return nesting;
}

/** The rows a filter keeps, by each row's own state. */
export function inboxFiltered(rows: readonly AgentRow[], filter: InboxFilter, activity: SidebarActivity): AgentRow[] {
  return filter === "all" ? [...rows] : rows.filter((row) => agentGroup(inboxStatus(row, activity)) === filter);
}

/**
 * The rows a typed query keeps, matched on the labels the Agents list shows (lib/sidebarFilter.ts), and kept when
 * the words the row draws (`words`: inboxWords) hold the query as typed, in any letter case: the palette's
 * subsequence match is too loose for a sentence. A blank query keeps all.
 */
export function inboxSearched(rows: readonly AgentRow[], query: string, machines: readonly Machine[], t: Translate, words: (row: AgentRow) => string | null): AgentRow[] {
  const filter = sidebarFilter(query, machines, { machineId: "", paneId: null }, t);
  if (!filter.active) return [...rows];
  const typed = query.trim().toLowerCase();
  return rows.filter((row) => machineFilter(filter, row.machine.id)?.panes.has(row.entry.pane.pane_id) === true || (words(row)?.toLowerCase().includes(typed) ?? false));
}

/** The rows in the order `held` names their keys, the rest after them in their given order. */
export function heldOrder<T>(rows: readonly T[], keyOf: (row: T) => string, held: readonly string[]): T[] {
  const place = new Map(held.map((key, index) => [key, index]));
  const rank = (row: T): number => place.get(keyOf(row)) ?? held.length;
  return [...rows].sort((a, b) => rank(a) - rank(b));
}

/** Why the list draws no row: a roster still on its way, no agent at all, or a filter or query that leaves none. */
export function inboxEmpty(machines: readonly Machine[], total: number, shown: number): "loading" | "none" | "no-match" | null {
  if (total === 0) return machines.length === 0 || machines.some((machine) => machine.state === "connected" && machine.snapshot === null) ? "loading" : "none";
  return shown === 0 ? "no-match" : null;
}

/**
 * An agent's last words as a row draws them: the one line the summary route sends (its block marks and line breaks
 * are the server's, shared/pane-summary.ts) without its inline marks (code, emphasis, a link as its text), as the
 * chat's inline reader reads them; null when nothing is left.
 */
export function plainWords(text: string): string | null {
  const bare = text.trim();
  const shown = (bare === "" ? "" : shownText(parseInline(bare, false)) ?? bare).trim();
  return shown === "" ? null : shown;
}

/** What a waiting agent asks, for its row: the question, then the first line of what it is about. */
export function questionWords(words: { question: string; body: string | null }): string {
  const first = words.body?.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
  return capped([words.question.trim(), first].filter((part) => part !== "").join("\n"), 240);
}

/** The agent's own words for its row, by its state; never words borrowed from another state. */
export function inboxWords(input: { group: AgentGroup; blocked: string | null; question: string | null; plan: PlanSummary | undefined; last: string | null }): string | null {
  if (input.group === "blocked") return input.blocked ?? input.question ?? input.last;
  if (input.group === "working") return input.plan?.current?.trim() || input.last;
  return input.last;
}

/**
 * Since when a row is in its state (ms): a waiting agent since this device saw it begin to wait (`waitStart`, the
 * stamp the Agents list reads too, lib/agentStateSince.ts), else since its last message (herdr tells no time of a
 * state change: the summary's time of its last words, which a done or ready row draws too, where the Agents list says
 * none); a working agent since the user last asked it, any other since its last words.
 */
export function inboxSinceAt(group: AgentGroup, summary: RowSummary | null | undefined, waitStart: number | null): number | null {
  if (group === "blocked") return waitStart ?? summary?.at ?? null;
  if (!summary) return null;
  return group === "working" ? summary.askedAt ?? summary.at : summary.at;
}

/** Whether the inbox mode opens on its list: the address names no pane, workspace or file. */
export function inboxStartsOpen(enabled: boolean, link: AppLink | null): boolean {
  return enabled && !(link !== null && Boolean(link.pane || link.workspace || fileFromLink(link)));
}
