// Command Code mod: tells the web UI which session this Command Code process shows.
//
// Command Code reports its session to herdr itself, but herdr keeps only the sessions of its own
// integrations, so `agent.get` never names one for a cmd pane. This writes
// `~/.commandcode/ovis/<pid>.json` = {pid, sessionId} at every session start (startup,
// --continue, --resume, /clear, /resume) and on each turn; the bridge reads it for the pane's own
// cmd process (server/cmd.ts). Install: cp integrations/cmd-session.ts ~/.commandcode/mods/ovis-session.ts
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type ModApi = {
  hooks(hooks: {
    onSessionStart?: (event: { sessionId?: unknown }) => void;
    onSessionEnd?: (event: { reason?: unknown }) => void;
  }): void;
  on(event: "run_start", handler: (event: { sessionId?: unknown }) => void): void;
};

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
}
