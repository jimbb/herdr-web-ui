import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { AgentStatus, HerdrPane } from "../../shared/protocol.ts";
import { paneCloseNeedsConfirm, usePaneClose, type ClosePaneRequest } from "./paneClose.ts";

const makePane = (pane_id: string, workspace_id = "w1", agent_status: AgentStatus = "idle"): HerdrPane =>
  ({ pane_id, workspace_id, tab_id: `${workspace_id}:t1`, terminal_id: `${pane_id}:term`, revision: 1, focused: false, agent_status }) as HerdrPane;

describe("paneCloseNeedsConfirm", () => {
  it("asks confirmation for a lone workspace pane, missing roster, or working/blocked agents", () => {
    const p1 = makePane("p1", "w1", "idle");
    const p2 = makePane("p2", "w1", "done");
    const other = makePane("p3", "w2", "idle");

    expect(paneCloseNeedsConfirm(p1, undefined)).toBe(true);
    expect(paneCloseNeedsConfirm(p1, [p1, other])).toBe(true);
    expect(paneCloseNeedsConfirm(p1, [p1, p2])).toBe(false);
    expect(paneCloseNeedsConfirm(p2, [p1, p2])).toBe(false);
    expect(paneCloseNeedsConfirm(makePane("w", "w1", "waiting"), [p1, makePane("w", "w1", "waiting")])).toBe(false);
    expect(paneCloseNeedsConfirm(makePane("w", "w1", "working"), [p1, p2])).toBe(true);
    expect(paneCloseNeedsConfirm(makePane("b", "w1", "blocked"), [p1, p2])).toBe(true);
  });
});

describe("usePaneClose", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    descriptors.set("IS_REACT_ACT_ENVIRONMENT", Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT"));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    const prev = descriptors.get("IS_REACT_ACT_ENVIRONMENT");
    if (prev) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", prev);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    descriptors.clear();
  });

  function harness() {
    let hook!: ReturnType<typeof usePaneClose>;
    function Probe(props: Parameters<typeof usePaneClose>[0]) {
      hook = usePaneClose(props);
      return null;
    }
    const mount = async (props: Parameters<typeof usePaneClose>[0]) => {
      await act(async () => { renderer = create(createElement(Probe, props)); });
    };
    const update = async (props: Parameters<typeof usePaneClose>[0]) => {
      await act(async () => { renderer!.update(createElement(Probe, props)); });
    };
    return { mount, update, get: () => hook };
  }

  it("closes idle multi-pane targets at once and reports success or failure", async () => {
    const p1 = makePane("p1", "w1", "idle");
    const p2 = makePane("p2", "w1", "idle");
    const calls: string[] = [];
    const events: string[] = [];
    let rejectNext = true;
    const h = harness();
    await h.mount({
      closePane: async (paneId, machineId) => {
        calls.push(`${machineId}:${paneId}`);
        if (rejectNext) {
          rejectNext = false;
          throw new Error("boom");
        }
      },
      roster: [p1, p2],
      isLive: (_machineId, paneId) => paneId === "p1" || paneId === "p2",
      onBeforeImmediate: (m, p) => events.push(`before:${m}:${p}`),
      onSuccess: (m, p) => events.push(`ok:${m}:${p}`),
      onError: (reason, m, p) => events.push(`err:${m}:${p}:${(reason as Error).message}`),
    });

    const req: ClosePaneRequest = { machineId: "local", pane: p1, panes: [p1, p2], label: "Agent" };
    await act(async () => { h.get().requestClose(req); });
    expect(calls).toEqual(["local:p1"]);
    expect(events).toEqual(["before:local:p1", "err:local:p1:boom"]);
    expect(h.get().closing).toBeNull();

    // Error cleared closingIn so retrying works.
    await act(async () => { h.get().requestClose(req); });
    expect(calls).toEqual(["local:p1", "local:p1"]);
    expect(events).toEqual(["before:local:p1", "err:local:p1:boom", "before:local:p1", "ok:local:p1"]);
  });

  it("asks confirmation for working/last panes, keeps errors retryable, and clears when cancelled", async () => {
    const p1 = makePane("p1", "w1", "working");
    const p2 = makePane("p2", "w1", "idle");
    const closed: string[] = [];
    const ok: string[] = [];
    let shouldFail = true;
    const live = new Set(["p1", "p2"]);
    const props = (): Parameters<typeof usePaneClose>[0] => ({
      closePane: async (paneId, machineId) => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("cannot close yet");
        }
        closed.push(`${machineId}:${paneId}`);
      },
      roster: [...live],
      isLive: (_m, paneId) => live.has(paneId),
      onSuccess: (m, p) => ok.push(`${m}:${p}`),
    });
    const h = harness();
    await h.mount(props());

    await act(async () => { h.get().requestClose({ machineId: "laptop", pane: p1, panes: [p1, p2], label: "Worker" }); });
    expect(h.get().closing).toEqual({ machineId: "laptop", pane: p1, label: "Worker" });
    expect(closed).toEqual([]);

    let threw = "";
    await act(async () => {
      try { await h.get().confirmClosing(); }
      catch (reason) { threw = (reason as Error).message; }
    });
    expect(threw).toBe("cannot close yet");
    expect(h.get().closing).not.toBeNull();
    expect(ok).toEqual([]);

    await act(async () => { await h.get().confirmClosing(); });
    expect(closed).toEqual(["laptop:p1"]);
    expect(ok).toEqual(["laptop:p1"]);
    expect(h.get().closing).toBeNull();

    // Once p1 leaves the roster, p2 becomes the last pane in w1 and clearClosing can dismiss its confirmation.
    live.delete("p1");
    await h.update(props());
    await act(async () => { h.get().requestClose({ machineId: "laptop", pane: p2, panes: [p2], label: "Last" }); });
    expect(h.get().closing?.label).toBe("Last");
    await act(async () => { h.get().clearClosing(); });
    expect(h.get().closing).toBeNull();
  });

  it("blocks a second close in the same (machine, workspace) until herdr drops the first, without conflating PCs (#3286)", async () => {
    const lp1 = makePane("p1", "w1", "idle");
    const lp2 = makePane("p2", "w1", "idle");
    const rp1 = makePane("p1", "w1", "idle");
    const rp2 = makePane("p2", "w1", "idle");
    const live = new Set(["local:p1", "local:p2", "laptop:p1", "laptop:p2"]);
    const calls: string[] = [];
    const baseProps = (panes: readonly string[]): Parameters<typeof usePaneClose>[0] => ({
      closePane: async (paneId, machineId) => { calls.push(`${machineId}:${paneId}`); },
      roster: [...panes],
      isLive: (m, p) => live.has(`${m}:${p}`),
    });
    const h = harness();
    await h.mount(baseProps([...live]));

    await act(async () => { h.get().requestClose({ machineId: "local", pane: lp2, panes: [lp1, lp2], label: "Local 2" }); });
    await act(async () => { h.get().requestClose({ machineId: "local", pane: lp1, panes: [lp1, lp2], label: "Local 1" }); });
    // Matching workspace_id on another PC is unaffected.
    await act(async () => { h.get().requestClose({ machineId: "laptop", pane: rp2, panes: [rp1, rp2], label: "Laptop 2" }); });
    expect(calls).toEqual(["local:p2", "laptop:p2"]);

    live.delete("local:p2");
    await h.update(baseProps([...live]));
    await act(async () => { h.get().requestClose({ machineId: "local", pane: lp1, panes: [lp1], label: "Local 1" }); });
    expect(h.get().closing).toEqual({ machineId: "local", pane: lp1, label: "Local 1" });
  });

  it("drops an open confirmation when locked, watching, gone, or when resetKey changes", async () => {
    const p1 = makePane("p1", "w1", "working");
    const p2 = makePane("p2", "w1", "idle");
    let live = true;
    let locked = false;
    let watching = false;
    let resetKey = "a";
    const h = harness();
    const makeProps = (): Parameters<typeof usePaneClose>[0] => ({
      closePane: async () => {},
      roster: { live, locked, watching },
      isLive: () => live,
      isLocked: () => locked,
      watching,
      resetKey,
    });
    await h.mount(makeProps());

    for (const mutate of [
      () => { locked = true; },
      () => { locked = false; watching = true; },
      () => { watching = false; live = false; },
      () => { live = true; resetKey = "b"; },
    ]) {
      await act(async () => { h.get().requestClose({ machineId: "local", pane: p1, panes: [p1, p2], label: "W" }); });
      expect(h.get().closing).not.toBeNull();
      mutate();
      await h.update(makeProps());
      expect(h.get().closing).toBeNull();
      locked = false; watching = false; live = true;
      await h.update(makeProps());
    }
  });
});
