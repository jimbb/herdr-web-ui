import type { HerdrPane, HerdrWorkspace, SessionSnapshot } from "../../shared/protocol.ts";
import { moveDestinations } from "./layoutTargets.ts";

export interface ThreadMoveEligibility {
  inMode: boolean;
  inboxShown: boolean;
  guideShown: boolean;
  watching: boolean;
  machineConnected: boolean;
  moveOffered: boolean;
  snapshot: Pick<SessionSnapshot, "workspaces" | "panes"> | null;
  pane: HerdrPane | null;
}

/**
 * Workspaces the open inbox thread can move to on the same machine: only in inbox thread view,
 * on a connected driving device whose herdr offers moves, for a one-pane tab, excluding its own
 * workspace (and Other terminals for helper panes, via lib/layoutTargets.ts).
 */
export function inboxThreadMoveDestinations(state: ThreadMoveEligibility): HerdrWorkspace[] {
  if (!state.inMode || state.inboxShown || state.guideShown || state.watching || !state.machineConnected || !state.moveOffered || !state.snapshot || !state.pane) {
    return [];
  }
  const tabPaneCount = state.snapshot.panes.filter((item) => item.tab_id === state.pane!.tab_id).length;
  if (tabPaneCount !== 1) return [];
  return moveDestinations(state.snapshot.workspaces, state.pane, state.pane.workspace_id);
}
