import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import {
  defaultKiroSessionDir,
  kiroTranscriptByCwd,
  kiroTranscriptInStore,
  parseKiroTranscript,
  unwrittenKiroSession,
} from "./kiro.ts";

// --- record builders mirroring kiro-cli's {version, kind, data} envelope ---
const line = (kind: string, data: unknown) => ({ version: 1, kind, data });
const prompt = (text: string, timestamp = 1_792_311_717) =>
  line("Prompt", { message_id: "p", content: [{ kind: "text", data: text }], meta: { timestamp } });
const assistant = (...blocks: unknown[]) => line("AssistantMessage", { message_id: "a", content: blocks });
const text = (data: string) => ({ kind: "text", data });
const thinking = (data: unknown) => ({ kind: "thinking", data });
const toolUse = (toolUseId: string, name: string, input: unknown) =>
  ({ kind: "toolUse", data: { toolUseId, name, input } });
const toolResults = (entries: { id: string; text: string; purpose?: string; error?: boolean }[]) =>
  line("ToolResults", {
    message_id: "r",
    content: entries.map((e) => ({ kind: "toolResult", data: { toolUseId: e.id, content: [{ kind: "text", data: e.text }] } })),
    results: Object.fromEntries(
      entries.map((e) => [
        e.id,
        { tool: { tool_use_purpose: e.purpose }, result: e.error ? { Error: {} } : { Success: {} } },
      ]),
    ),
  });
const jsonl = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n");

const tools = (turn: ConversationTurn | undefined) =>
  (turn?.parts ?? []).filter((p): p is Extract<ConversationPart, { kind: "tool" }> => p.kind === "tool");
const firstTool = (turn: ConversationTurn | undefined) => {
  const t = tools(turn)[0];
  if (!t) throw new Error("expected a tool part");
  return t;
};

describe("parseKiroTranscript", () => {
  it("reconstructs a user prompt then an assistant turn with text, thinking and a paired tool", () => {
    const transcript = jsonl(
      prompt("what does this do?"),
      assistant(
        thinking({ text: "", redactedContent: [1, 2, 3] }),
        text("Let me read the file."),
        toolUse("tool-1", "read", { __tool_use_purpose: "read the entry point", path: "/app/main.ts" }),
      ),
      toolResults([{ id: "tool-1", text: "export const x = 1;", purpose: "read the entry point" }]),
      assistant(text("It exports x.")),
    );
    const turns = parseKiroTranscript(transcript);
    expect(turns.length).toBe(2);

    const [user, asst] = turns;
    expect(user!.role).toBe("user");
    expect(user!.ts).toBe(new Date(1_792_311_717 * 1000).toISOString());
    expect(user!.parts).toEqual([{ kind: "text", text: "what does this do?" }]);

    expect(asst!.role).toBe("assistant");
    // encrypted reasoning becomes a folded marker, never fabricated text
    expect(asst!.parts.find((p) => p.kind === "thinking")).toEqual({ kind: "thinking", text: "[reasoning]" });
    const tool = firstTool(asst);
    expect(tool.name).toBe("read");
    expect(tool.summary).toBe("read the entry point");
    expect(tool.output).toBe("export const x = 1;");
    expect(tool.error).toBeUndefined();
    // the final assistant text is present
    expect(asst!.parts.some((p) => p.kind === "text" && p.text === "It exports x.")).toBe(true);
  });

  it("pairs a tool result to its call by toolUseId and flags errors from result.Error", () => {
    const transcript = jsonl(
      prompt("run it"),
      assistant(toolUse("t-err", "executeBash", { __tool_use_purpose: "run build", command: "make" })),
      toolResults([{ id: "t-err", text: "make: *** error", purpose: "run build", error: true }]),
    );
    const [, asst] = parseKiroTranscript(transcript);
    const tool = firstTool(asst);
    expect(tool.error).toBe(true);
    expect(tool.summary).toBe("run build");
    expect(tool.output).toBe("make: *** error");
  });

  it("keeps a tool result with no matching call as a standalone tool part", () => {
    const transcript = jsonl(
      prompt("hi"),
      toolResults([{ id: "orphan", text: "surprise output" }]),
    );
    const turns = parseKiroTranscript(transcript);
    // user turn + an assistant turn holding the orphan result
    expect(turns.length).toBe(2);
    expect(firstTool(turns[1]).output).toBe("surprise output");
  });

  it("starts a new turn on each prompt and keeps order", () => {
    const transcript = jsonl(
      prompt("first", 1_792_311_700),
      assistant(text("answer one")),
      prompt("second", 1_792_311_800),
      assistant(text("answer two")),
    );
    const turns = parseKiroTranscript(transcript);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(turns[2]!.parts).toEqual([{ kind: "text", text: "second" }]);
  });

  it("honors maxTurns by keeping the last N", () => {
    const transcript = jsonl(
      prompt("one"), assistant(text("a")),
      prompt("two"), assistant(text("b")),
      prompt("three"), assistant(text("c")),
    );
    const turns = parseKiroTranscript(transcript, 2);
    expect(turns.length).toBe(2);
    expect(turns[0]!.parts).toEqual([{ kind: "text", text: "three" }]);
  });

  it("skips blank lines and unparsable records without throwing", () => {
    const transcript = [JSON.stringify(prompt("hi")), "", "not json", JSON.stringify(assistant(text("ok")))].join("\n");
    const turns = parseKiroTranscript(transcript);
    expect(turns.length).toBe(2);
  });

  it("drops empty turns", () => {
    // a prompt with no text and an assistant with only whitespace text produce nothing
    const transcript = jsonl(
      line("Prompt", { content: [], meta: { timestamp: 1 } }),
      assistant(text("   ")),
    );
    expect(parseKiroTranscript(transcript)).toEqual([]);
  });
});

describe("kiro store confinement", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });
  const store = () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "herdr-kiro-store-")));
    dirs.push(d);
    return d;
  };

  it("accepts a .jsonl regular file inside the store", () => {
    const dir = store();
    const path = join(dir, "sess.jsonl");
    writeFileSync(path, "{}\n");
    expect(kiroTranscriptInStore(path, dir)).toBe(path);
  });

  it("rejects a path outside the store", () => {
    const dir = store();
    const outside = store();
    const path = join(outside, "sess.jsonl");
    writeFileSync(path, "{}\n");
    expect(kiroTranscriptInStore(path, dir)).toBeNull();
  });

  it("rejects a non-.jsonl file and a directory", () => {
    const dir = store();
    const notJsonl = join(dir, "sess.json");
    writeFileSync(notJsonl, "{}\n");
    expect(kiroTranscriptInStore(notJsonl, dir)).toBeNull();
    mkdirSync(join(dir, "sub.jsonl"));
    expect(kiroTranscriptInStore(join(dir, "sub.jsonl"), dir)).toBeNull();
  });

  it("rejects a symlink escaping the store", () => {
    const dir = store();
    const outside = store();
    const target = join(outside, "real.jsonl");
    writeFileSync(target, "{}\n");
    const link = join(dir, "link.jsonl");
    symlinkSync(target, link);
    expect(kiroTranscriptInStore(link, dir)).toBeNull();
  });

  it("recognizes an unwritten session named inside the store", () => {
    const dir = store();
    const path = join(dir, "abcd-1234.jsonl");
    const found = unwrittenKiroSession(path, dir);
    expect(found).toEqual({ id: "abcd-1234", path });
  });

  it("does not treat an existing file as unwritten", () => {
    const dir = store();
    const path = join(dir, "written.jsonl");
    writeFileSync(path, "{}\n");
    expect(unwrittenKiroSession(path, dir)).toBeNull();
  });

  it("defaultKiroSessionDir honors KIRO_SESSION_DIR", () => {
    const prev = process.env["KIRO_SESSION_DIR"];
    process.env["KIRO_SESSION_DIR"] = "/tmp/custom-kiro";
    try {
      expect(defaultKiroSessionDir()).toBe("/tmp/custom-kiro");
    } finally {
      if (prev === undefined) delete process.env["KIRO_SESSION_DIR"];
      else process.env["KIRO_SESSION_DIR"] = prev;
    }
  });
});

describe("kiroTranscriptByCwd fallback (herdr reports no session path)", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });
  const store = () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "herdr-kiro-cwd-")));
    dirs.push(d);
    return d;
  };
  /** Write a session's jsonl + sidecar. updated is an ISO string; reason defaults to interactive. */
  const session = (
    dir: string,
    id: string,
    opts: { cwd: string; updated: string; reason?: string; body?: string },
  ) => {
    writeFileSync(join(dir, `${id}.jsonl`), opts.body ?? JSON.stringify({ version: 1, kind: "Prompt", data: {} }) + "\n");
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({ session_id: id, cwd: opts.cwd, updated_at: opts.updated, session_created_reason: opts.reason ?? "cli" }),
    );
  };

  it("returns the only interactive session matching the cwd", () => {
    const dir = store();
    const cwd = "/home/jimmy/projects/beermoney";
    session(dir, "only", { cwd, updated: "2026-10-18T10:00:00.000Z" });
    session(dir, "other-cwd", { cwd: "/home/jimmy/projects/elsewhere", updated: "2026-10-18T11:00:00.000Z" });
    expect(kiroTranscriptByCwd(cwd, dir)).toEqual({ path: join(dir, "only.jsonl") });
  });

  it("picks the clear most-recent winner when it leads by the margin", () => {
    const dir = store();
    const cwd = "/home/jimmy/projects";
    session(dir, "old", { cwd, updated: "2026-10-18T10:00:00.000Z" });
    session(dir, "new", { cwd, updated: "2026-10-18T10:05:00.000Z" }); // 5 min newer > 60s margin
    expect(kiroTranscriptByCwd(cwd, dir)).toEqual({ path: join(dir, "new.jsonl") });
  });

  it("returns null when two candidates are too close to disambiguate", () => {
    const dir = store();
    const cwd = "/home/jimmy/projects";
    session(dir, "a", { cwd, updated: "2026-10-18T10:00:00.000Z" });
    session(dir, "b", { cwd, updated: "2026-10-18T10:00:30.000Z" }); // 30s < 60s margin
    expect(kiroTranscriptByCwd(cwd, dir)).toBeNull();
  });

  it("does not exclude a session merely for session_created_reason=subagent (all kiro sessions carry it)", () => {
    const dir = store();
    const cwd = "/home/jimmy/projects/beermoney";
    session(dir, "sub", { cwd, updated: "2026-10-18T12:00:00.000Z", reason: "subagent" });
    expect(kiroTranscriptByCwd(cwd, dir)).toEqual({ path: join(dir, "sub.jsonl") });
  });

  it("excludes empty transcripts and sessions without a sidecar", () => {
    const dir = store();
    const cwd = "/home/jimmy/projects/beermoney";
    writeFileSync(join(dir, "empty.jsonl"), "");
    writeFileSync(join(dir, "empty.json"), JSON.stringify({ cwd, updated_at: "2026-10-18T10:00:00.000Z" }));
    writeFileSync(join(dir, "nosidecar.jsonl"), JSON.stringify({ version: 1, kind: "Prompt", data: {} }) + "\n");
    expect(kiroTranscriptByCwd(cwd, dir)).toBeNull();
  });

  it("returns null when no session matches the cwd", () => {
    const dir = store();
    session(dir, "x", { cwd: "/somewhere/else", updated: "2026-10-18T10:00:00.000Z" });
    expect(kiroTranscriptByCwd("/home/jimmy/projects/beermoney", dir)).toBeNull();
  });
});
