/**
 * The Agents list's rows in the order it draws them: the pinned card first, in pin order, then
 * every PC's agents in the roster's order, or in that PC's own Activity order when Settings asks
 * for it (lib/sidebarOrder.ts). A row is its PC and its pane: two PCs may reuse a pane id.
 */
import type { Machine } from "../../shared/machines.ts";
import { isBackgroundRole, ROLE_TOKEN } from "../../shared/pane-tokens.ts";
import { nestHelpers, sidebarAgents, type SidebarAgent } from "../../shared/agent-roster.ts";
import type { AgentStatus } from "../../shared/protocol.ts";
import { activityOrder } from "./sidebarOrder.ts";
import { knownStatus } from "./status.ts";
import { sidebarPinKey, splitPinnedRows } from "./sidebarPins.ts";
import { nestRows } from "../../shared/attention.ts";

export { nestHelpers } from "../../shared/agent-roster.ts";

export { AGENT_GROUPS, agentGroup, groupAgentRows, nestRows, type AgentGroup, type AgentGroupOptions } from "../../shared/attention.ts";

export interface AgentRow { machine: Machine; entry: SidebarAgent }

export interface AgentRosterOptions {
  /** Settings → Agents order: Activity sorts each PC's rows by that PC's own counters */
  byActivity: boolean;
  /** a PC's state-change counters, as lib/sidebarActivity.tsx keeps them */
  seqs(machineId: string): ReadonlyMap<string, number>;
  /** the pinned rows' keys (lib/sidebarPins.ts), in pin order */
  pinned: readonly string[];
}

/** Every PC's agent rows as the list draws them: the pinned ones first, then the rest in source order. */
export function agentRoster(machines: readonly Machine[], options: AgentRosterOptions): { pinned: AgentRow[]; rest: AgentRow[] } {
  const rows = machines.flatMap((machine) => {
    const agents = sidebarAgents(machine.snapshot);
    return nestHelpers(options.byActivity ? activityOrder(agents, (entry) => entry.pane, options.seqs(machine.id)) : agents).map((entry): AgentRow => ({ machine, entry }));
  });
  return splitPinnedRows(rows, options.pinned, ({ machine, entry }) => sidebarPinKey(machine.id, entry.pane.pane_id));
}

/**
 * Whether a launcher tagged the pane as a background agent: `herdr pane report-metadata <pane>
 * --token role=background` (any case, spaces around it ignored). Nothing is guessed: a pane
 * without the token is one a person drives.
 */
export function isBackgroundAgent({ pane, agent }: SidebarAgent): boolean {
  return isBackgroundRole((pane.tokens ?? agent?.tokens)?.[ROLE_TOKEN]);
}

/**
 * The list's unpinned rows split into the agents a person drives and the background ones (workers,
 * subagents), each in the order given. A background row is one tagged `role=background`, or a
 * helper started (herdr-core's `parent_pane_id`) by one, looked up in `all` (the whole roster); a
 * blocked one stays with the people's rows, so a question is never folded away.
 */
export function splitBackgroundRows(rows: readonly AgentRow[], status: (row: AgentRow) => AgentStatus | undefined, all: readonly AgentRow[] = rows): { people: AgentRow[]; background: AgentRow[] } {
  // a helper's agent is looked up among every row, pinned or filtered out ones too
  const byKey = new Map(all.map((row) => [sidebarPinKey(row.machine.id, row.entry.pane.pane_id), row]));
  const tagged = (row: AgentRow): boolean => {
    // up the helpers chain to the first tagged row; a loop ends the walk
    const passed = new Set<AgentRow>();
    for (let up: AgentRow | undefined = row; up && !passed.has(up); up = up.entry.pane.parent_pane_id === undefined ? undefined : byKey.get(sidebarPinKey(up.machine.id, up.entry.pane.parent_pane_id))) {
      if (isBackgroundAgent(up.entry)) return true;
      passed.add(up);
    }
    return false;
  };
  const people: AgentRow[] = [];
  const background: AgentRow[] = [];
  for (const row of rows) (tagged(row) && knownStatus(status(row)) !== "blocked" ? background : people).push(row);
  // each part is laid out anew: a helper whose agent went to the other part stands as a root, not under another row
  const keyOf = ({ machine, entry }: AgentRow): string => sidebarPinKey(machine.id, entry.pane.pane_id);
  const nest = (part: AgentRow[]): AgentRow[] => nestRows(part, keyOf, ({ machine, entry }) => entry.pane.parent_pane_id === undefined ? undefined : sidebarPinKey(machine.id, entry.pane.parent_pane_id));
  return { people: nest(people), background: nest(background) };
}

/** Nested rows (an agent, then the helpers under it) cut into families: a row that names an earlier member of the family before it as its parent joins that family. */
export function agentFamilies(rows: readonly AgentRow[]): AgentRow[][] {
  const families: AgentRow[][] = [];
  let members = new Set<string>();
  for (const row of rows) {
    const parent = row.entry.pane.parent_pane_id;
    if (families.length > 0 && parent !== undefined && members.has(sidebarPinKey(row.machine.id, parent))) families.at(-1)!.push(row);
    else { families.push([row]); members = new Set(); }
    members.add(sidebarPinKey(row.machine.id, row.entry.pane.pane_id));
  }
  return families;
}
