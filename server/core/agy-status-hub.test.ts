import { describe, expect, it, spyOn } from "bun:test";
import { handlers, hub } from "./status.fake.ts";

// herdr-core's own record of an agy turn its agent executor stopped (hc 0.1.21), as the pane reported it
const error = "agent executor error: expected tool step at index 1059, got CORTEX_STEP_TYPE_ERROR_MESSAGE";
const agy = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent_status: "idle", agent: "agy" };

function agyHub() {
  const h = hub();
  const failures: string[] = [];
  spyOn(h.status.push, "onFailed").mockImplementation(async (paneId: string) => { failures.push(paneId); });
  h.herdrSays(agy);
  handlers.onBaseline([agy]);
  return { ...h, failures };
}

describe("an agy pane whose agent executor stopped its turn", () => {
  it("rests as idle and tells the failure once, never DONE", async () => {
    const h = agyHub();
    handlers.onStatus(agy.pane_id, "working", "agy");
    handlers.onStatus(agy.pane_id, "unknown", "agy", undefined, error);
    expect(h.last().status).toBe("idle");
    expect(h.failures).toEqual([agy.pane_id]);
    // herdr-core says done for the turn it no longer runs: the failed rest still stands, as for a Claude API error
    handlers.onStatus(agy.pane_id, "done", "agy");
    expect(h.last().status).toBe("idle");
    expect(h.failures).toEqual([agy.pane_id]);
  });

  it("tells nothing of an error found on a first sighting", async () => {
    const h = agyHub();
    handlers.onStatus(agy.pane_id, "unknown", "agy", undefined, error);
    expect(h.failures).toEqual([]);
    expect(h.last().status).toBe("idle");
  });

  it("tells the error of a turn the server found already working", async () => {
    const h = hub();
    const failures: string[] = [];
    spyOn(h.status.push, "onFailed").mockImplementation(async (paneId: string) => { failures.push(paneId); });
    h.herdrSays({ ...agy, agent_status: "working" });
    handlers.onBaseline([{ ...agy, agent_status: "working" }]);
    handlers.onStatus(agy.pane_id, "unknown", "agy", undefined, error);
    expect(failures).toEqual([agy.pane_id]);
  });

  it("tells the same error once", async () => {
    const h = agyHub();
    handlers.onStatus(agy.pane_id, "working", "agy");
    handlers.onStatus(agy.pane_id, "unknown", "agy", undefined, error);
    handlers.onStatus(agy.pane_id, "unknown", "agy", undefined, error);
    expect(h.failures).toEqual([agy.pane_id]);
  });

  it("finishes the next turn normally", async () => {
    const h = agyHub();
    handlers.onStatus(agy.pane_id, "working", "agy");
    handlers.onStatus(agy.pane_id, "unknown", "agy", undefined, error);
    handlers.onStatus(agy.pane_id, "working", "agy");
    handlers.onStatus(agy.pane_id, "done", "agy");
    expect(h.last().status).toBe("done");
    expect(h.failures).toEqual([agy.pane_id]);
  });
});
