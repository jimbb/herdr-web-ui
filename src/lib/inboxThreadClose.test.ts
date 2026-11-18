import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { CircleHelp, FolderOpen, Link, PanelsTopLeft, Search, Settings } from "lucide-react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import type { RowMenuItem } from "../components/RowMenu.tsx";
import { ApiError } from "./api.ts";
import {
  buildModeMoreItems,
  buildModeThreadItems,
  canCloseInboxThread,
  useInboxThreadClose,
  type UseInboxThreadCloseOptions,
} from "./inboxThreadClose.ts";
import { SettingsProvider } from "./settings.ts";
import { setSidebarPins } from "./sidebarPins.ts";

const makePane = (pane_id: string, workspace_id = "w1", agent_status: AgentStatus = "idle"): HerdrPane =>
  ({ pane_id, workspace_id, tab_id: `${workspace_id}:t1`, terminal_id: `${pane_id}:term`, revision: 1, focused: false, agent_status }) as HerdrPane;

const makeSnapshot = (panes: HerdrPane[]): SessionSnapshot =>
  ({ protocol: 22, version: "test", agents: [], workspaces: [], tabs: [], panes, layouts: [] }) as SessionSnapshot;

const makeMachine = (id: string, panes: HerdrPane[], state: Machine["state"] = "connected"): Machine =>
  ({ id, name: id, kind: id === "local" ? "local" : "ssh", enabled: true, state, error: null, snapshot: makeSnapshot(panes) });

const menuItem = (id: string, label = id, divider = false): RowMenuItem => ({
  id,
  label,
  icon: Link,
  divider,
  run: () => {},
});

describe("canCloseInboxThread", () => {
  const base = {
    inMode: true,
    inboxShown: false,
    guideShown: false,
    watching: false,
    machineConnected: true,
    paneLocked: false,
    hasPane: true,
  };

  it("allows closing only an unlocked, connected open thread on a driving device", () => {
    expect(canCloseInboxThread(base)).toBe(true);
    expect(canCloseInboxThread({ ...base, inMode: false })).toBe(false);
    expect(canCloseInboxThread({ ...base, inboxShown: true })).toBe(false);
    expect(canCloseInboxThread({ ...base, guideShown: true })).toBe(false);
    expect(canCloseInboxThread({ ...base, watching: true })).toBe(false);
    expect(canCloseInboxThread({ ...base, machineConnected: false })).toBe(false);
    expect(canCloseInboxThread({ ...base, paneLocked: true })).toBe(false);
    expect(canCloseInboxThread({ ...base, hasPane: false })).toBe(false);
  });
});

describe("buildModeThreadItems and buildModeMoreItems", () => {
  it("appends Close pane as a danger item with a divider at the end of thread items", () => {
    const base = [
      { id: "files", label: "Browse files", icon: FolderOpen, divider: true, run: () => {} },
      { id: "copy-link", label: "Copy link", icon: Link, divider: true, run: () => {} },
    ];
    const withClose = buildModeThreadItems(base, { label: "Close pane", run: () => {} });
    expect(withClose.map((item) => [item.id, item.divider === true, item.danger === true])).toEqual([
      ["files", false, false],
      ["copy-link", false, false],
      ["close", true, true],
    ]);

    const withoutClose = buildModeThreadItems(base, null);
    expect(withoutClose.map((item) => [item.id, item.divider === true])).toEqual([
      ["files", false],
      ["copy-link", false],
    ]);
  });

  it("places Close pane cleanly in both phone and wide thread More menus and omits it on lists", () => {
    const palette = [{ id: "palette", label: "Search panes and actions", icon: Search, run: () => {} }];
    const lead = [{ id: "exit-inbox", label: "Back to Ovis", icon: PanelsTopLeft, run: () => {} }, ...palette];
    const end = [menuItem("alerts", "Alerts", false), { id: "settings", label: "Settings", icon: Settings, divider: true, run: () => {} }];
    const app = [...lead, ...end];
    const thread = buildModeThreadItems([
      { id: "next-waiting", label: "Open the next session waiting for you", icon: CircleHelp, run: () => {} },
      menuItem("copy-link", "Copy link"),
    ], { label: "Close pane", run: () => {} });

    const phoneThread = buildModeMoreItems({ inboxWide: false, inboxShown: false, hasPane: true }, { palette, lead, thread, end, app });
    expect(phoneThread.map((item) => [item.id, item.divider === true, item.danger === true])).toEqual([
      ["exit-inbox", false, false],
      ["palette", false, false],
      ["next-waiting", true, false],
      ["copy-link", false, false],
      ["close", true, true],
      ["alerts", true, false],
      ["settings", false, false],
    ]);

    const phoneList = buildModeMoreItems({ inboxWide: false, inboxShown: true, hasPane: true }, { palette, lead, thread, end, app });
    expect(phoneList.map((item) => [item.id, item.divider === true])).toEqual([
      ["exit-inbox", false],
      ["palette", false],
      ["alerts", false],
      ["settings", true],
    ]);

    const wideThread = buildModeMoreItems({ inboxWide: true, inboxShown: false, hasPane: true }, { palette, lead, thread, end, app });
    expect(wideThread.map((item) => [item.id, item.divider === true, item.danger === true])).toEqual([
      ["palette", false, false],
      ["next-waiting", true, false],
      ["copy-link", false, false],
      ["close", true, true],
    ]);

    expect(buildModeMoreItems({ inboxWide: true, inboxShown: true, hasPane: true }, { palette, lead, thread, end, app }).map((item) => item.id)).toEqual(["palette"]);
    expect(buildModeMoreItems({ inboxWide: true, inboxShown: false, hasPane: false }, { palette, lead, thread, end, app }).map((item) => item.id)).toEqual(["palette"]);
  });
});

describe("useInboxThreadClose", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const stored = new Map<string, string>();
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "localStorage", "IS_REACT_ACT_ENVIRONMENT"]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    stored.clear();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    };
    const events = new EventTarget();
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define("IS_REACT_ACT_ENVIRONMENT", true);
    define("localStorage", storage);
    define("getComputedStyle", () => ({ getPropertyValue: () => "" }));
    define("navigator", { languages: ["en-US"] });
    define("window", {
      localStorage: storage,
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    });
    define("document", {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    });
    setSidebarPins([]);
  });

  afterEach(async () => {
    setSidebarPins([]);
    await act(async () => renderer?.unmount());
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  function mountHook() {
    let controller!: ReturnType<typeof useInboxThreadClose>;
    function Probe(props: UseInboxThreadCloseOptions) {
      controller = useInboxThreadClose(props);
      return null;
    }
    const mount = async (props: UseInboxThreadCloseOptions) => {
      await act(async () => {
        renderer = create(createElement(SettingsProvider, null, createElement(Probe, props)));
      });
    };
    const update = async (props: UseInboxThreadCloseOptions) => {
      await act(async () => {
        renderer!.update(createElement(SettingsProvider, null, createElement(Probe, props)));
      });
    };
    return { mount, update, get: () => controller };
  }

  it("withholds close when watching, offline, locked, on the list, or outside inbox mode", async () => {
    const p1 = makePane("p1", "w1", "idle");
    const p2 = makePane("p2", "w1", "idle");
    const online = makeMachine("local", [p1, p2], "connected");
    const offline = makeMachine("local", [p1, p2], "disconnected");
    const closeCalls: string[] = [];

    stored.set("ovis:settings", JSON.stringify({ agentLocks: true, lockedAgents: ["local:p1"] }));
    setSidebarPins(["local:p1"]);

    const base = (over: Partial<UseInboxThreadCloseOptions> = {}): UseInboxThreadCloseOptions => ({
      machines: [online],
      inMode: true,
      inboxShown: false,
      guideShown: false,
      watching: false,
      selectedMachineId: "local",
      selectedMachine: online,
      selectedPane: p1,
      labelFor: () => "Agent One",
      onClosed: () => {},
      closePane: async (paneId, machineId) => { closeCalls.push(`${machineId}:${paneId}`); },
      recordMenuUse: () => {},
      ...over,
    });

    const h = mountHook();
    await h.mount(base());
    expect(h.get().offered).toBe(false);
    await act(async () => { h.get().request(); h.get().requestFromMenu(); });
    expect(closeCalls).toEqual([]);
    expect(h.get().closing).toBeNull();

    await act(async () => { setSidebarPins([]); });
    await h.update(base({ watching: true }));
    expect(h.get().offered).toBe(false);

    await h.update(base({ selectedMachine: offline, machines: [offline] }));
    expect(h.get().offered).toBe(false);

    await h.update(base({ inboxShown: true }));
    expect(h.get().offered).toBe(false);

    await h.update(base({ inMode: false }));
    expect(h.get().offered).toBe(false);

    await h.update(base({ selectedPane: null }));
    expect(h.get().offered).toBe(false);

    await act(async () => { h.get().request(); h.get().requestFromMenu(); });
    expect(closeCalls).toEqual([]);

    await h.update(base());
    expect(h.get().offered).toBe(true);
  });

  it("confirms working/last panes, notifies onClosed, and suppresses return-row focus only for the closed thread", async () => {
    const p1 = makePane("p1", "w1", "working");
    const p2 = makePane("p2", "w1", "idle");
    const local = makeMachine("local", [p1, p2], "connected");
    const closed: string[] = [];
    const onClosedEvents: string[] = [];
    const menuUses: string[] = [];
    let inboxShown = false;

    const props = (): UseInboxThreadCloseOptions => ({
      machines: [local],
      inMode: true,
      inboxShown,
      guideShown: false,
      watching: false,
      selectedMachineId: "local",
      selectedMachine: local,
      selectedPane: p1,
      labelFor: (_m, pane) => pane.pane_id === "p1" ? "Working Agent" : "Idle Agent",
      onClosed: (machineId, paneId) => {
        onClosedEvents.push(`${machineId}:${paneId}`);
        inboxShown = true;
      },
      closePane: async (paneId, machineId) => { closed.push(`${machineId}:${paneId}`); },
      recordMenuUse: (machineId) => { menuUses.push(machineId); },
    });

    const h = mountHook();
    await h.mount(props());

    await act(async () => { h.get().requestFromMenu(); });
    expect(menuUses).toEqual(["local"]);
    expect(h.get().closing).toEqual({ machineId: "local", pane: p1, label: "Working Agent" });
    expect(closed).toEqual([]);

    await act(async () => { h.get().clearClosing(); });
    expect(h.get().closing).toBeNull();
    expect(onClosedEvents).toEqual([]);

    await act(async () => { h.get().request(); });
    expect(h.get().closing?.label).toBe("Working Agent");

    await act(async () => { await h.get().confirmClosing(); });
    expect(closed).toEqual(["local:p1"]);
    expect(onClosedEvents).toEqual(["local:p1"]);
    expect(h.get().closing).toBeNull();

    await h.update(props());
    expect(h.get().suppressedReturnRow("local:p1")).toBeNull();
    expect(h.get().suppressedReturnRow("local:p2")).toBe("local:p2");

    // Reopening a thread clears suppression so a normal Back later focuses the row again.
    inboxShown = false;
    await h.update(props());
    inboxShown = true;
    await h.update(props());
    expect(h.get().suppressedReturnRow("local:p1")).toBe("local:p1");
  });

  it("closes idle non-last panes immediately, handles routeMissing/errors, and drops confirmation or stale errors on state change", async () => {
    const p1 = makePane("p1", "w1", "idle");
    const p2 = makePane("p2", "w1", "idle");
    const w2Only = makePane("p3", "w2", "idle");
    let local = makeMachine("local", [p1, p2, w2Only], "connected");
    let selectedPane: HerdrPane = p1;
    let inboxShown = false;
    let watching = false;
    let nextFailure: unknown = new ApiError("/api/pane/close", 404, "missing", "not_found");
    const closed: string[] = [];
    const onClosedEvents: string[] = [];

    const props = (): UseInboxThreadCloseOptions => ({
      machines: [local],
      inMode: true,
      inboxShown,
      guideShown: false,
      watching,
      selectedMachineId: "local",
      selectedMachine: local,
      selectedPane,
      labelFor: (_m, pane) => `Thread ${pane.pane_id}`,
      onClosed: (machineId, paneId) => { onClosedEvents.push(`${machineId}:${paneId}`); },
      closePane: async (paneId, machineId) => {
        if (nextFailure !== null) {
          const reason = nextFailure;
          nextFailure = null;
          throw reason;
        }
        closed.push(`${machineId}:${paneId}`);
      },
      recordMenuUse: () => {},
    });

    const h = mountHook();
    await h.mount(props());

    await act(async () => {
      h.get().requestFromMenu();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(h.get().closing).toBeNull();
    expect(h.get().error).toEqual({ message: "This PC's bridge does not offer this yet", detail: null });
    expect(onClosedEvents).toEqual([]);

    await act(async () => { h.get().clearError(); });
    expect(h.get().error).toBeNull();

    nextFailure = new Error("bridge timeout");
    await act(async () => {
      h.get().request();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(h.get().error).toEqual({
      message: "Close failed: Something went wrong. Try again.",
      detail: "bridge timeout",
    });

    // Switching threads clears the error from the previous thread.
    selectedPane = w2Only;
    await h.update(props());
    expect(h.get().error).toBeNull();

    // Closing a lone workspace pane opens confirmation and clears if PC disconnects or user backs to list.
    await act(async () => { h.get().request(); });
    expect(h.get().closing?.pane.pane_id).toBe("p3");
    local = makeMachine("local", [p1, p2, w2Only], "disconnected");
    await h.update(props());
    expect(h.get().closing).toBeNull();

    local = makeMachine("local", [p1, p2, w2Only], "connected");
    selectedPane = p1;
    await h.update(props());
    await act(async () => {
      h.get().request();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(closed).toEqual(["local:p1"]);
    expect(onClosedEvents).toEqual(["local:p1"]);
    expect(h.get().suppressedReturnRow("local:p1")).toBeNull();

    inboxShown = true;
    await h.update(props());
    expect(h.get().offered).toBe(false);
    watching = true;
    inboxShown = false;
    await h.update(props());
    expect(h.get().offered).toBe(false);
  });
});
