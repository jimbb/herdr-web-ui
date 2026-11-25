import { describe, expect, it } from "bun:test";

import { HC_OTHER_WORKSPACE_ID } from "../../shared/machines.ts";
import type { HerdrPane, HerdrWorkspace } from "../../shared/protocol.ts";
import { inboxThreadMoveDestinations, type ThreadMoveEligibility } from "./inboxThreadMove.ts";

const ws = (workspace_id: string, label: string): HerdrWorkspace =>
  ({ workspace_id, label, tab_count: 1, active_tab_id: `${workspace_id}:t1` }) as HerdrWorkspace;

const pane = (pane_id: string, workspace_id: string, tab_id: string, extra: Partial<HerdrPane> = {}): HerdrPane =>
  ({ pane_id, workspace_id, tab_id, ...extra }) as HerdrPane;

describe("inboxThreadMoveDestinations", () => {
  const solo = pane("p1", "w1", "w1:t1");
  const helper = pane("p2", "w1", "w1:t2", { parent_pane_id: "p1" });
  const splitA = pane("p3", "w1", "w1:t3");
  const splitB = pane("p4", "w1", "w1:t3");
  const workspaces = [ws("w1", "Automation"), ws("w2", "Ovis"), ws(HC_OTHER_WORKSPACE_ID, "Other terminals")];
  const snapshot = { workspaces, panes: [solo, helper, splitA, splitB] };

  const base = (over: Partial<ThreadMoveEligibility> = {}): ThreadMoveEligibility => ({
    inMode: true,
    inboxShown: false,
    guideShown: false,
    watching: false,
    machineConnected: true,
    moveOffered: true,
    snapshot,
    pane: solo,
    ...over,
  });

  it("lists the machine's other workspaces for a one-pane tab on a connected driving device", () => {
    expect(inboxThreadMoveDestinations(base()).map((entry) => entry.workspace_id)).toEqual(["w2", HC_OTHER_WORKSPACE_ID]);
    expect(inboxThreadMoveDestinations(base({ pane: helper })).map((entry) => entry.workspace_id)).toEqual(["w2"]);
  });

  it("offers no move outside an inbox thread, when watching, offline, unsupported, split, or with no other workspace", () => {
    expect(inboxThreadMoveDestinations(base({ inMode: false }))).toEqual([]);
    expect(inboxThreadMoveDestinations(base({ inboxShown: true }))).toEqual([]);
    expect(inboxThreadMoveDestinations(base({ guideShown: true }))).toEqual([]);
    expect(inboxThreadMoveDestinations(base({ watching: true }))).toEqual([]);
    expect(inboxThreadMoveDestinations(base({ machineConnected: false }))).toEqual([]);
    expect(inboxThreadMoveDestinations(base({ moveOffered: false }))).toEqual([]);
    expect(inboxThreadMoveDestinations(base({ pane: splitA }))).toEqual([]);
    expect(inboxThreadMoveDestinations(base({ pane: null }))).toEqual([]);
    expect(inboxThreadMoveDestinations(base({ snapshot: null }))).toEqual([]);
    expect(inboxThreadMoveDestinations(base({ snapshot: { workspaces: [ws("w1", "Automation")], panes: [solo] } }))).toEqual([]);
  });
});
