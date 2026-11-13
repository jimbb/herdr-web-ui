/**
 * Caveman Code extension (a pi 0.65 fork): makes a caveman-code pane an agent pane for herdr and the chat.
 *
 * herdr has no Caveman Code integration, so this reports the pane as the custom agent `caveman-code`
 * (https://herdr.dev/docs/add-herdr-support): idle or working, the command that reopens the session
 * after a herdr restart (`caveman-code --session <file>`), and a release on quit. herdr keeps no session
 * for a custom source, so it also writes `<agent dir>/ovis/<pid>.json` = {pid, sessionFile}, which
 * server/caveman.ts reads for the pane's own caveman-code process.
 * Install: bun scripts/install-caveman-integration.ts
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/** Caveman Code's agent directory: its default, ~/.cave/agent. */
export const cavemanAgentDir = (home = homedir()): string => join(home, ".cave", "agent");

export interface CavemanContext {
  hasUI?: boolean;
  isIdle?(): boolean;
  sessionManager?: { getSessionFile(): unknown };
}

export interface CavemanExtensionAPI {
  on(event: "session_start" | "agent_start" | "agent_end" | "session_shutdown", handler: (event: unknown, context: CavemanContext) => unknown): void;
}

const SOURCE = "caveman-code";
const REPORT_TIMEOUT_MS = 1_500;

export function cavemanHerdrReporter(caveman: CavemanExtensionAPI, env: NodeJS.ProcessEnv = process.env, home = homedir()): void {
  const socketPath = env["HERDR_SOCKET_PATH"];
  const paneId = env["HERDR_PANE_ID"];
  if (env["HERDR_ENV"] !== "1" || !socketPath || !paneId) return;
  const sidecarDir = join(cavemanAgentDir(home), "ovis");
  const sidecar = join(sidecarDir, `${process.pid}.json`);
  // must increase across this agent's restarts too: a timestamp
  let seq = Date.now() * 1000;
  const send = (method: string, params: Record<string, unknown>): Promise<void> => new Promise((done) => {
    const socket = createConnection(socketPath);
    const finish = () => { socket.destroy(); done(); };
    socket.on("error", finish);
    socket.on("data", finish);
    socket.on("end", finish);
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: `${SOURCE}:${seq}`, method, params: { pane_id: paneId, source: SOURCE, agent: SOURCE, seq: ++seq, ...params } })}\n`));
    setTimeout(finish, REPORT_TIMEOUT_MS).unref?.();
  });

  let root = false;
  let sessionFile: string | null = null;
  // reports go out one at a time, in order, so a late one never overwrites a newer state
  let chain = Promise.resolve();
  const report = (state: "idle" | "working") => {
    // herdr refuses a resume command whose argument holds an apostrophe, and the whole report with it
    const resume = sessionFile !== null && !sessionFile.includes("'") ? { resume_argv: [SOURCE, "--session", sessionFile] } : {};
    chain = chain.then(() => send("pane.report_agent", { state, ...resume }));
  };

  caveman.on("session_start", (_event, context) => {
    // print and JSON modes run headless: no pane to report
    if (context?.hasUI !== true) return;
    root = true;
    const file = context.sessionManager?.getSessionFile();
    sessionFile = typeof file === "string" && file.length > 0 ? file : null;
    if (sessionFile !== null) {
      try {
        mkdirSync(sidecarDir, { recursive: true, mode: 0o700 });
        const temporary = `${sidecar}.${Date.now()}.tmp`;
        writeFileSync(temporary, JSON.stringify({ pid: process.pid, sessionFile }), { mode: 0o600 });
        renameSync(temporary, sidecar);
      } catch { /* the chat shows Terminal */ }
    }
    report(context.isIdle?.() === false ? "working" : "idle");
  });
  caveman.on("agent_start", () => { if (root) report("working"); });
  // Caveman Code 0.65 has no agent_settled: agent_end is the last event of a run
  caveman.on("agent_end", () => { if (root) report("idle"); });
  caveman.on("session_shutdown", async () => {
    if (!root) return;
    rmSync(sidecar, { force: true });
    await chain;
    await send("pane.release_agent", {});
  });
}

export default function cavemanExtension(caveman: CavemanExtensionAPI): void {
  cavemanHerdrReporter(caveman);
}
