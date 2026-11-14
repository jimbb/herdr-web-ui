import { expect, it } from "bun:test";
import { resumeLine } from "./cmd-session.ts";

// shaped like command-code@1.89.0's buildHerdrLine (dist/cli.mjs)
const line = (method: string, params: Record<string, unknown>) =>
  `${JSON.stringify({ id: "3", method, params: { pane_id: "w1:p1", source: "custom:cmd", agent: "cmd", seq: 1794645928954003, ...params } })}\n`;

it("adds the session's resume command to Command Code's state reports, once its session report named it", () => {
  const state = { session: null as string | null };
  const idle = line("pane.report_agent", { state: "idle" });
  // before the session report: nothing to resume yet
  expect(resumeLine(idle, state)).toBe(idle);
  const session = line("pane.report_agent_session", { agent_session_id: "e70b9536-5455-463c-824b-6dae947a8a2e" });
  expect(resumeLine(session, state)).toBe(session);
  const resumed = JSON.parse(resumeLine(line("pane.report_agent", { state: "working" }), state));
  expect(resumed.params).toMatchObject({ state: "working", seq: 1794645928954003, resume_argv: ["command-code", "--session", "e70b9536-5455-463c-824b-6dae947a8a2e"] });
  // /clear: the next session replaces it
  resumeLine(line("pane.report_agent_session", { agent_session_id: "next-id" }), state);
  expect(JSON.parse(resumeLine(idle, state)).params.resume_argv).toEqual(["command-code", "--session", "next-id"]);
});

it("leaves every other line alone, and adds no command for an id herdr would refuse", () => {
  const state = { session: "abc" };
  for (const other of [
    line("pane.report_metadata", { title: "x" }),
    line("pane.release_agent", {}),
    `${JSON.stringify({ id: "1", method: "pane.report_agent", params: { source: "custom:other", state: "idle" } })}\n`,
    'not json "custom:cmd"',
    "GET / HTTP/1.1\r\n",
  ]) expect(resumeLine(other, state)).toBe(other);
  resumeLine(line("pane.report_agent_session", { agent_session_id: "it's" }), state);
  const idle = line("pane.report_agent", { state: "idle" });
  expect(resumeLine(idle, state)).toBe(idle);
});
