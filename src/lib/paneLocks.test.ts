import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { SettingsProvider } from "./settings.ts";
import { setSidebarPins } from "./sidebarPins.ts";
import { lockedPinKeys, locksAfterPinToggle, toggleAgentLock, usePaneLockChecker } from "./paneLocks.ts";

describe("locked agent rows", () => {
  it("holds a lock only while its row is pinned", () => {
    expect([...lockedPinKeys(["pc:p1", "pc:p2"], ["pc:p2", "pc:p3"])]).toEqual(["pc:p2"]);
    expect(lockedPinKeys([], ["pc:p1"]).size).toBe(0);
    expect(lockedPinKeys(["pc:p1"], ["pc:p1"], false).size).toBe(0);
  });

  it("locks and unlocks a pinned row, dropping the locks of rows no longer pinned", () => {
    expect(toggleAgentLock([], ["pc:p1"], "pc:p1")).toEqual(["pc:p1"]);
    expect(toggleAgentLock(["pc:p1"], ["pc:p1"], "pc:p1")).toEqual([]);
    expect(toggleAgentLock(["gone:p9"], ["pc:p1"], "pc:p1")).toEqual(["pc:p1"]);
  });

  it("starts a fresh pin unlocked: a lock left behind by an unpin that had not heard of it does not come back (#2977)", () => {
    expect(locksAfterPinToggle(["pc:p1", "pc:p2"], ["pc:p2", "pc:p1"], "pc:p1")).toEqual(["pc:p2"]);
    expect(locksAfterPinToggle(["pc:p1", "pc:p2", "gone:p9"], ["pc:p2"], "pc:p1")).toEqual(["pc:p2"]);
  });

  it("never locks a row that is not pinned", () => {
    expect(toggleAgentLock([], ["pc:p2"], "pc:p1")).toEqual([]);
  });
});

describe("usePaneLockChecker", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const stored = new Map<string, string>();
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "localStorage", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    stored.clear();
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
    const events = new EventTarget();
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define("IS_REACT_ACT_ENVIRONMENT", true);
    define("localStorage", storage);
    define("getComputedStyle", () => ({ getPropertyValue: () => "" }));
    define("navigator", { languages: ["en-US"] });
    define("window", { localStorage: storage, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
    define("document", { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
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

  it("checks locks per (machine, pane) only while pinned and enabled", async () => {
    let checker!: (machineId: string, paneId: string) => boolean;
    function Probe() {
      checker = usePaneLockChecker();
      return null;
    }
    stored.set("ovis:settings", JSON.stringify({ agentLocks: true, lockedAgents: ["local:p1", "local:p2"] }));
    setSidebarPins(["local:p1", "laptop:p1"]);

    await act(async () => {
      renderer = create(createElement(SettingsProvider, null, createElement(Probe)));
    });
    expect([checker("local", "p1"), checker("laptop", "p1"), checker("local", "p2")]).toEqual([true, false, false]);

    await act(async () => { setSidebarPins(["laptop:p1"]); });
    expect([checker("local", "p1"), checker("laptop", "p1")]).toEqual([false, false]);

    await act(async () => renderer?.unmount());
    renderer = undefined;
    stored.set("ovis:settings", JSON.stringify({ agentLocks: false, lockedAgents: ["local:p1"] }));
    setSidebarPins(["local:p1"]);
    await act(async () => {
      renderer = create(createElement(SettingsProvider, null, createElement(Probe)));
    });
    expect(checker("local", "p1")).toBe(false);
  });
});
