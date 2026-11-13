import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cavemanHerdrReporter, type CavemanContext, type CavemanExtensionAPI } from "./caveman-code.ts";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A herdr socket that answers every request and keeps what it was sent. */
async function herdr(): Promise<{ path: string; root: string; requests: { method: string; params: Record<string, unknown> }[] }> {
  const root = mkdtempSync(join(tmpdir(), "cav-"));
  roots.push(root);
  const path = join(root, "herdr.sock");
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const server = createServer((socket) => socket.on("data", (data) => {
    requests.push(JSON.parse(data.toString()));
    socket.write(`{"result":{"type":"ok"}}\n`);
  }));
  servers.push(server);
  await new Promise<void>((done) => server.listen(path, done));
  return { path, root, requests };
}

function caveman(): CavemanExtensionAPI & { fire(event: string, context?: CavemanContext): Promise<unknown> } {
  const handlers = new Map<string, (event: unknown, context: CavemanContext) => unknown>();
  return {
    on: (event, handler) => { handlers.set(event, handler); },
    fire: async (event, context = {}) => await handlers.get(event)?.({}, context),
  };
}

const until = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(10); };

it("reports the pane as caveman-code with its resume command, names the session for the chat, and releases on quit", async () => {
  const socket = await herdr();
  const agent = caveman();
  cavemanHerdrReporter(agent, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket.path, HERDR_PANE_ID: "w1:p1" }, socket.root);
  const sidecar = join(socket.root, ".cave", "agent", "ovis", `${process.pid}.json`);

  await agent.fire("session_start", { hasUI: true, isIdle: () => true, sessionManager: { getSessionFile: () => "/s/one.jsonl" } });
  expect(JSON.parse(readFileSync(sidecar, "utf8"))).toEqual({ pid: process.pid, sessionFile: "/s/one.jsonl" });
  await agent.fire("agent_start");
  await agent.fire("agent_end");
  await until(() => socket.requests.length === 3);
  expect(socket.requests.map((request) => request.params["state"])).toEqual(["idle", "working", "idle"]);
  expect(socket.requests[0]!.params).toMatchObject({ pane_id: "w1:p1", source: "caveman-code", agent: "caveman-code", resume_argv: ["caveman-code", "--session", "/s/one.jsonl"] });
  const seqs = socket.requests.map((request) => request.params["seq"] as number);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

  await agent.fire("session_shutdown");
  expect(existsSync(sidecar)).toBe(false);
  expect(socket.requests.at(-1)!.method).toBe("pane.release_agent");
});

it("does nothing outside herdr or in a headless run", async () => {
  const socket = await herdr();
  const outside = caveman();
  cavemanHerdrReporter(outside, {}, socket.root);
  await outside.fire("session_start", { hasUI: true, sessionManager: { getSessionFile: () => "/s/one.jsonl" } });
  const headless = caveman();
  cavemanHerdrReporter(headless, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket.path, HERDR_PANE_ID: "w1:p1" }, socket.root);
  await headless.fire("session_start", { hasUI: false, sessionManager: { getSessionFile: () => "/s/one.jsonl" } });
  await headless.fire("agent_start");
  await Bun.sleep(50);
  expect(socket.requests).toEqual([]);
  expect(existsSync(join(socket.root, ".cave"))).toBe(false);
});
