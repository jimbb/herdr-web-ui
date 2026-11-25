import { describe, expect, it } from "bun:test";

import { HC_OTHER_WORKSPACE_ID } from "../../shared/machines.ts";
import type { HerdrPane, HerdrWorkspace } from "../../shared/protocol.ts";
import { createRequest, dialogLaunch, firstMessageOf, firstMessageOutcome, matchingWorkspaceForFolder, newSessionLaunch, startNewSession } from "./newSession.ts";
import { inFlightGuard } from "./sessionHistory.ts";

const plain = { claudeLaunchMode: "default", codexLaunchMode: "default" } as const;

describe("newSessionLaunch", () => {
  it("passes Codex's prompt behind the separator and queues nothing for it", () => {
    const launch = newSessionLaunch({ agent: "codex", model: "", effort: "", prompt: " $review-pr the branch " }, plain);
    expect(launch).toEqual({ agent: { kind: "codex", args: ["--", "$review-pr the branch"] }, prompt: { text: "$review-pr the branch", via: "positional" } });
    expect(firstMessageOf(launch)).toBeNull();
  });

  it("starts Claude Code and every other agent without the prompt, and queues it as the request's first message", () => {
    const claude = newSessionLaunch({ agent: "claude", model: "opus", effort: "high", prompt: "Fix it" }, { ...plain, claudeLaunchMode: "plan" });
    expect(claude).toEqual({ agent: { kind: "claude", args: ["--permission-mode", "plan", "--model", "opus", "--effort", "high"] }, prompt: { text: "Fix it", via: "pending" } });
    expect(firstMessageOf(claude)).toBe("Fix it");
    expect(newSessionLaunch({ agent: "claude", model: "", effort: "medium", ultracode: true, prompt: "Fix it" }, plain))
      .toEqual({ agent: { kind: "claude", args: ["--effort", "medium", "--settings", "{\"ultracode\":true}"] }, prompt: { text: "Fix it", via: "pending" } });
    expect(newSessionLaunch({ agent: "claude", model: "", effort: "", ultracode: false, prompt: "" }, plain)).toEqual({ agent: { kind: "claude" }, prompt: null });
    const omp = newSessionLaunch({ agent: "omp", model: "", effort: "", prompt: "Plan the config file" }, plain);
    expect(omp).toEqual({ agent: { kind: "omp" }, prompt: { text: "Plan the config file", via: "pending" } });
    expect(firstMessageOf(omp)).toBe("Plan the config file");
    expect(newSessionLaunch({ agent: "omp", model: "", effort: "", prompt: "  " }, plain)).toEqual({ agent: { kind: "omp" }, prompt: null });
    expect(newSessionLaunch({ agent: "", model: "", effort: "", prompt: "" }, plain)).toEqual({ agent: null, prompt: null });
  });

  it("names the first choice an agent's launch does not take, and queues nothing for it", () => {
    expect(newSessionLaunch({ agent: "omp", model: "gpt-5", effort: "", prompt: "" }, plain)).toEqual({ fault: "model" });
    expect(newSessionLaunch({ agent: "omp", model: "", effort: "high", prompt: "" }, plain)).toEqual({ fault: "effort" });
    expect(newSessionLaunch({ agent: "codex", model: "", effort: "ultracode", prompt: "" }, plain)).toEqual({ fault: "effort" });
    // Ultracode is no level of Claude Code's effort list, and no agent but Claude Code takes the switch
    expect(newSessionLaunch({ agent: "claude", model: "", effort: "ultracode", prompt: "" }, plain)).toEqual({ fault: "effort" });
    expect(newSessionLaunch({ agent: "codex", model: "", effort: "", ultracode: true, prompt: "go" }, plain)).toEqual({ fault: "ultracode" });
    expect(newSessionLaunch({ agent: "", model: "", effort: "", prompt: "a shell runs no agent" }, plain)).toEqual({ fault: "prompt" });
    expect(firstMessageOf({ fault: "prompt" })).toBeNull();
  });
});

describe("the dialog's launch", () => {
  it("drops the Ultracode switch where the agent's launch does not take it, so a switch no longer shown never disables Start", () => {
    expect(dialogLaunch({ agent: "", model: "", effort: "", ultracode: true, prompt: "" }, plain)).toEqual({ agent: null, prompt: null });
    expect(dialogLaunch({ agent: "codex", model: "", effort: "", ultracode: true, prompt: "go" }, plain))
      .toEqual({ agent: { kind: "codex", args: ["--", "go"] }, prompt: { text: "go", via: "positional" } });
    expect(dialogLaunch({ agent: "claude", model: "", effort: "", ultracode: true, prompt: "" }, plain))
      .toEqual({ agent: { kind: "claude", args: ["--settings", "{\"ultracode\":true}"] }, prompt: null });
    expect(dialogLaunch({ agent: "claude", model: "two words", effort: "", ultracode: true, prompt: "" }, plain)).toEqual({ fault: "model" });
  });
});

describe("the create request", () => {
  const ready = (fields: Parameters<typeof newSessionLaunch>[0]) => {
    const launch = newSessionLaunch(fields, plain);
    if ("fault" in launch) throw new Error("fault");
    return launch;
  };
  it("leaves first_message out when there is none, so its body is the one a bridge before it took", () => {
    expect(createRequest({ tab: null, directory: " /work ", name: "" }, ready({ agent: "codex", model: "", effort: "", prompt: "" }), "c1"))
      .toEqual({ cwd: "/work", label: null, agent: { kind: "codex" } });
    expect(createRequest({ tab: { workspaceId: "w1", cwd: null }, directory: "", name: " API " }, ready({ agent: "codex", model: "", effort: "", prompt: "go" }), "c1"))
      .toEqual({ workspace_id: "w1", cwd: null, label: "API", agent: { kind: "codex", args: ["--", "go"] } });
  });
  it("names this page's connection with a first message, and none when the page has no open connection", () => {
    const launch = ready({ agent: "omp", model: "", effort: "", prompt: "Fix it" });
    expect(createRequest({ tab: null, directory: "/w", name: "" }, launch, "c1")).toEqual({ cwd: "/w", label: null, agent: { kind: "omp" }, first_message: "Fix it", first_message_connection: "c1" });
    expect(createRequest({ tab: null, directory: "/w", name: "" }, launch, null)).toEqual({ cwd: "/w", label: null, agent: { kind: "omp" }, first_message: "Fix it" });
  });
  it("sends Codex a prompt with a tab or a line break as the first message: one command-line argument is one line", () => {
    const launch = ready({ agent: "codex", model: "", effort: "", prompt: "first line\nsecond\tcolumn" });
    expect(launch).toEqual({ agent: { kind: "codex" }, prompt: { text: "first line\nsecond\tcolumn", via: "pending" } });
  });
});

describe("what became of the first message", () => {
  const sent = { cwd: "/w", label: null, agent: { kind: "omp" }, first_message: "Fix it" };
  const made = { workspace_id: "w1", pane_id: "p1", agent_started: true };
  it("tells a queued message from one the bridge could not queue and from a bridge that ignored the field", () => {
    expect(firstMessageOutcome(sent, { ...made, first_message: { id: "m1" } })).toEqual({ kind: "queued" });
    expect(firstMessageOutcome(sent, { ...made, first_message: { error: { code: "pending_limit", message: "full" } } }))
      .toEqual({ kind: "not_queued", error: { code: "pending_limit", message: "full" } });
    expect(firstMessageOutcome(sent, made)).toEqual({ kind: "not_queued", error: null });
  });
  it("has nothing to say without a first message, or when the agent did not start", () => {
    expect(firstMessageOutcome({ cwd: "/w", label: null, agent: { kind: "codex" } }, made)).toEqual({ kind: "none" });
    expect(firstMessageOutcome(sent, { ...made, agent_started: false, first_message: null })).toEqual({ kind: "none" });
  });
});

describe("Start's in-flight guard", () => {
  it("sends one create however often Start is pressed while the first is in flight, then takes the next", async () => {
    const guard = inFlightGuard();
    const sent: unknown[] = [];
    let release = (): void => {};
    const create = (body: unknown) => {
      sent.push(body);
      return new Promise<{ pane_id: string }>((resolve) => { release = () => resolve({ pane_id: `p${sent.length}` }); });
    };
    const launch = newSessionLaunch({ agent: "omp", model: "", effort: "", prompt: "Fix it" }, plain);
    if ("fault" in launch) throw new Error("fault");
    const request = createRequest({ tab: { workspaceId: "w1", cwd: null }, directory: "", name: "" }, launch, "c1");
    const start = () => startNewSession(guard, request, create);
    const first = start();
    expect(first).not.toBeNull();
    expect(start()).toBeNull();
    expect(start()).toBeNull();
    expect(guard.busy()).toBeTrue();
    release();
    await expect(first).resolves.toEqual({ pane_id: "p1" });
    expect(sent).toEqual([{ workspace_id: "w1", cwd: null, label: null, agent: { kind: "omp" }, first_message: "Fix it", first_message_connection: "c1" }]);
    expect(guard.busy()).toBeFalse();
    expect(start()).not.toBeNull();
    expect(sent).toHaveLength(2);
  });
});

describe("matchingWorkspaceForFolder", () => {
  const ws = (workspace_id: string, label: string, checkout_path?: string): HerdrWorkspace => ({
    workspace_id,
    label,
    tab_count: 1,
    active_tab_id: `${workspace_id}:t1`,
    ...(checkout_path ? { worktree: { repo_key: "r", repo_name: label, repo_root: checkout_path, checkout_path, is_linked_worktree: false } } : {}),
  }) as HerdrWorkspace;
  const pane = (pane_id: string, workspace_id: string, cwd?: string): HerdrPane =>
    ({ pane_id, workspace_id, tab_id: `${workspace_id}:t1`, cwd }) as HerdrPane;

  const snapshot = {
    workspaces: [
      ws(HC_OTHER_WORKSPACE_ID, "Other terminals"),
      ws("w1", "Automation", "/home/u/Automation"),
      ws("w2", "ovis"),
    ],
    panes: [
      pane("o:p1", HC_OTHER_WORKSPACE_ID, "/home/u/scratch"),
      pane("w1:p1", "w1", "/home/u/Automation/subdir"),
      pane("w2:p1", "w2", "/home/u/ovis/"),
      pane("w2:p2", "w2", "/home/u/other"),
    ],
  };

  it("matches by checkout_path or first pane cwd, normalising trailing slashes and ~ when home is known", () => {
    expect(matchingWorkspaceForFolder("/home/u/Automation/", snapshot)).toEqual({ workspace: snapshot.workspaces[1]!, cwd: "/home/u/Automation" });
    expect(matchingWorkspaceForFolder(" /home/u/ovis ", snapshot)).toEqual({ workspace: snapshot.workspaces[2]!, cwd: "/home/u/ovis" });
    expect(matchingWorkspaceForFolder("~/Automation/", snapshot, "/home/u/")).toEqual({ workspace: snapshot.workspaces[1]!, cwd: "/home/u/Automation" });
    expect(matchingWorkspaceForFolder("~/ovis", snapshot, "/home/u")).toEqual({ workspace: snapshot.workspaces[2]!, cwd: "/home/u/ovis" });
  });

  it("does not match Other terminals, non-first pane cwds, checkout_path overrides, blank folders, or missing snapshots", () => {
    expect(matchingWorkspaceForFolder("/home/u/scratch", snapshot)).toBeNull();
    expect(matchingWorkspaceForFolder("/home/u/other", snapshot)).toBeNull();
    expect(matchingWorkspaceForFolder("/home/u/Automation/subdir", snapshot)).toBeNull();
    expect(matchingWorkspaceForFolder("   ", snapshot)).toBeNull();
    expect(matchingWorkspaceForFolder("/home/u/ovis", null)).toBeNull();
    expect(matchingWorkspaceForFolder("~/ovis", snapshot, null)).toBeNull();
  });
});
