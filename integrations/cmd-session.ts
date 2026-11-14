// Command Code mod: tells the web UI which session this Command Code process shows, and herdr how
// to reopen it.
//
// Command Code reports its session to herdr itself, but herdr keeps only the sessions of its own
// integrations, so `agent.get` never names one for a cmd pane. This writes
// `~/.commandcode/ovis/<pid>.json` = {pid, sessionId} at every session start (startup,
// --continue, --resume, /clear, /resume) and on each turn; the bridge reads it for the pane's own
// cmd process (server/cmd.ts).
//
// Command Code sends herdr no resume command either, so herdr cannot reopen a cmd pane after a
// restart. herdr ignores a report from Command Code's source that is not numbered above its last
// one, so this adds `command-code --session <id>` to Command Code's own state reports as they are
// written to herdr's socket (resumeLine).
// Install: cp integrations/cmd-session.ts ~/.commandcode/mods/ovis-session.ts
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

type ModApi = {
  hooks(hooks: {
    onSessionStart?: (event: { sessionId?: unknown }) => void;
    onSessionEnd?: (event: { reason?: unknown }) => void;
  }): void;
  on(event: "run_start", handler: (event: { sessionId?: unknown }) => void): void;
};

/**
 * A line Command Code writes to herdr's socket, with `resume_argv` added to its state reports
 * (`pane.report_agent`) once its session report has named the session: that report comes first
 * at every session start. `state.session` carries the session between lines. Any other line is
 * returned as it is.
 */
export function resumeLine(line: string, state: { session: string | null }): string {
  // herdr's lines are small JSON objects: an API request body is passed by without a parse
  if (line.length > 64 * 1024 || !line.startsWith("{") || !line.includes('"custom:cmd"')) return line;
  let request: { method?: unknown; params?: Record<string, unknown> };
  try { request = JSON.parse(line); } catch { return line; }
  const params = request?.params;
  if (params?.["source"] !== "custom:cmd") return line;
  const id = params["agent_session_id"];
  // herdr refuses the whole report over a bad argument: only a plain id goes in
  if (request.method === "pane.report_agent_session" && typeof id === "string") state.session = /^[\w-]{1,128}$/.test(id) ? id : null;
  if (request.method !== "pane.report_agent" || state.session === null) return line;
  return `${JSON.stringify({ ...request, params: { ...params, resume_argv: ["command-code", "--session", state.session] } })}\n`;
}

export default function (cmd: ModApi): void {
  if (process.env.HERDR_ENV !== "1") return;
  const dir = join(homedir(), ".commandcode", "ovis");
  const file = join(dir, `${process.pid}.json`);
  let published: string | null = null;
  const publish = (sessionId: unknown) => {
    if (typeof sessionId !== "string" || sessionId === "" || sessionId === published) return;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${Date.now()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ pid: process.pid, sessionId }), { mode: 0o600 });
      renameSync(temporary, file);
      published = sessionId;
    } catch { /* the pane's chat uses Terminal */ }
  };
  cmd.hooks({
    onSessionStart: ({ sessionId }) => publish(sessionId),
    onSessionEnd: ({ reason }) => {
      if (reason !== "shutdown") return;
      published = null;
      rmSync(file, { force: true });
    },
  });
  cmd.on("run_start", ({ sessionId }) => publish(sessionId));

  // ponytail: wraps every socket write in this process to reach Command Code's private reporter;
  // drop it once Command Code sends resume_argv itself
  const resume = { session: null as string | null };
  const write = Socket.prototype.write as (this: Socket, chunk: unknown, ...rest: unknown[]) => boolean;
  Socket.prototype.write = function (this: Socket, chunk: unknown, ...rest: unknown[]) {
    return write.call(this, typeof chunk === "string" ? resumeLine(chunk, resume) : chunk, ...rest);
  } as typeof Socket.prototype.write;
}
