import { afterAll, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cavemanTranscriptPath, isCavemanProcess } from "./caveman.ts";

const home = mkdtempSync(join(tmpdir(), "ovis-caveman-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const agent = join(home, ".cave", "agent");
const project = join(agent, "sessions", "--tmp--");
mkdirSync(project, { recursive: true });
mkdirSync(join(agent, "ovis"));
const written = join(project, "2026-11-13T00-00-00-000Z_6a811b4e-c352-4d6b-95e6-3fc2d2dd1ebf.jsonl");
writeFileSync(written, `${JSON.stringify({ type: "session", version: 3, id: "x", cwd: "/tmp" })}\n`);
const unwritten = join(project, "2026-11-13T00-00-01-000Z_00000000-0000-4000-8000-000000000000.jsonl");
const bind = (pid: number, sessionFile: string, writer = pid) =>
  writeFileSync(join(agent, "ovis", `${pid}.json`), JSON.stringify({ pid: writer, sessionFile }));
bind(10, written);
bind(11, unwritten);
bind(12, "/etc/passwd.jsonl");
bind(13, written, 99);
const caveman = (pid: number) => ({ pid, name: "caveman-code" });

it("resolves the session the extension names for the pane's caveman", async () => {
  expect(await cavemanTranscriptPath("p", [{ pid: 1, name: "bash" }, caveman(10)], home)).toEqual({ path: written });
  expect(await cavemanTranscriptPath("p", [caveman(11)], home)).toEqual({ unwritten: { id: "2026-11-13T00-00-01-000Z_00000000-0000-4000-8000-000000000000", path: unwritten } });
});

it("rejects outside the store, another pid's file, two cavemen, a non-caveman process", async () => {
  expect(await cavemanTranscriptPath("p", [caveman(12)], home)).toBeNull();
  expect(await cavemanTranscriptPath("p", [caveman(13)], home)).toBeNull();
  expect(await cavemanTranscriptPath("p", [caveman(10), caveman(11)], home)).toBeNull();
  expect(await cavemanTranscriptPath("p", [{ pid: 10, name: "node" }], home)).toBeNull();
  expect(await cavemanTranscriptPath("p", [caveman(14)], home)).toBeNull();
});

it("knows caveman-code by its process title or its npm entry, never by a bare `caveman`", () => {
  expect(isCavemanProcess(["caveman-code"])).toBe(true);
  expect(isCavemanProcess(["/usr/bin/node", "/home/u/.local/bin/caveman-code"])).toBe(true);
  expect(isCavemanProcess(["node", "/usr/lib/node_modules/@juliusbrussee/caveman-code/dist/cli.js"])).toBe(true);
  expect(isCavemanProcess(["node", "/home/u/.local/bin/caveman"])).toBe(false);
  expect(isCavemanProcess(["caveman"])).toBe(false);
  expect(isCavemanProcess(["bash"])).toBe(false);
});
