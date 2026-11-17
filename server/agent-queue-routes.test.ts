import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineEvent, ServerMessage } from "../shared/protocol.ts";
import type { QueueSnapshot, QueueTask } from "../shared/agent-queue.ts";
import { AgentQueueService } from "./agent-queue.ts";
import type { HcTerminal } from "./herdr-core/snapshot.ts";
import { createServer, type ServerInstance } from "./index.ts";
import { authenticatedWebSocket } from "./remote-websocket.ts";

const BROWSER_TOKEN = "queue-browser-token";
const BRIDGE_TOKEN = "b".repeat(64);
const WATCH_TOKEN = "w".repeat(64);

const roots: string[] = [];
const servers: ServerInstance[] = [];

function makeDir(prefix = "ovis-queue-routes-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()!.stop();
  }
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

function writeWatchDevice(stateDir: string): void {
  writeFileSync(
    join(stateDir, "devices.json"),
    JSON.stringify({
      gate_closed_at: new Date().toISOString(),
      devices: [
        {
          id: "0123456789abcdef",
          label: "Watch tablet",
          role: "watch",
          token_hash: createHash("sha256").update(WATCH_TOKEN).digest("hex"),
          created_at: new Date().toISOString(),
          last_seen_at: null,
        },
      ],
    }),
    { mode: 0o600 },
  );
}

function makeTerminal(address: string, overrides: Partial<HcTerminal> = {}): HcTerminal {
  return {
    address,
    cols: 120,
    rows: 40,
    cwd: "/tmp",
    state: "live",
    turn: 0,
    labels: {},
    status: { state: "idle", app: "claude" },
    ...overrides,
  };
}

function startQueueServer(options: { withQueue?: boolean; readMemAvailableMb?: () => number | null; terminals?: HcTerminal[] } = {}) {
  const root = makeDir();
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  writeWatchDevice(stateDir);

  let nextPane = 1;
  const terminals: HcTerminal[] = options.terminals ?? [];
  const startedPrompts: Array<{ paneId: string; prompt: string }> = [];
  let memMb: number | null = 8192;

  const agentQueue =
    options.withQueue === false
      ? null
      : new AgentQueueService({
          stateDir,
          getPreferences: () => ({ revision: 0, settings: {} }),
          readMemAvailableMb: options.readMemAvailableMb ?? (() => memMb),
          getTerminals: async () => [...terminals],
          openTab: async (folder) => {
            const paneId = `hc:queue-${nextPane++}`;
            terminals.push(makeTerminal(paneId, { cwd: folder }));
            return paneId;
          },
          launchAgent: async (paneId, agent) => {
            const kind = typeof agent.kind === "string" ? agent.kind : "claude";
            const existing = terminals.find((t) => t.address === paneId);
            if (existing) existing.status = { state: "idle", app: kind };
            return { agent_started: true };
          },
          deliverPrompt: async (paneId, text, deps) => {
            deps?.beforeSend?.();
            startedPrompts.push({ paneId, prompt: text });
          },
          forgetLaunchedAgent: () => undefined,
          now: () => Date.parse("2026-11-18T00:00:00.000Z"),
        });

  const server = createServer({
    port: 0,
    hostname: "127.0.0.1",
    stateDir,
    token: BROWSER_TOKEN,
    bridgeToken: BRIDGE_TOKEN,
    sidecar: false,
    tailscaleOwner: null,
    agentQueue,
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;

  return {
    root,
    stateDir,
    server,
    base,
    agentQueue,
    terminals,
    startedPrompts,
    setMemMb: (next: number | null) => {
      memMb = next;
    },
    url: (path: string) => `${base}${path}`,
    authHeaders: (token = BROWSER_TOKEN, extra: Record<string, string> = {}) => ({
      authorization: `Bearer ${token}`,
      origin: base,
      ...extra,
    }),
    watchHeaders: (extra: Record<string, string> = {}) => ({
      cookie: `ovis_device=${WATCH_TOKEN}`,
      "x-forwarded-for": "100.64.0.9",
      origin: base,
      ...extra,
    }),
  };
}

async function wsClient(base: string) {
  const frames: ServerMessage[] = [];
  const waiters = new Set<() => void>();
  const socket = authenticatedWebSocket(`${base.replace("http:", "ws:")}/ws`, BROWSER_TOKEN);
  socket.onmessage = (event) => {
    frames.push(JSON.parse(String(event.data)) as ServerMessage);
    for (const check of waiters) check();
  };
  const wait = <T extends ServerMessage>(matches: (frame: ServerMessage) => frame is T): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error("Timed out waiting for WebSocket frame"));
      }, 5_000);
      const check = () => {
        const hit = frames.find(matches);
        if (hit) {
          clearTimeout(timer);
          waiters.delete(check);
          resolve(hit);
        }
      };
      waiters.add(check);
      check();
    });

  await wait((frame): frame is Extract<ServerMessage, { type: "features" }> => frame.type === "features");
  return { socket, frames, wait };
}

describe("agent-queue HTTP API & health capability", () => {
  it("advertises agent_queue on authenticated /api/health?scope=bridge only when enabled", async () => {
    const enabled = startQueueServer({ withQueue: true });
    const unauth = await (await fetch(enabled.url("/api/health?scope=bridge"))).json() as Record<string, unknown>;
    expect(unauth["agent_queue"]).toBeUndefined();

    const authed = await (
      await fetch(enabled.url("/api/health?scope=bridge"), { headers: { authorization: `Bearer ${BROWSER_TOKEN}` } })
    ).json() as Record<string, unknown>;
    expect(authed["agent_queue"]).toBe(true);

    const watch = await (
      await fetch(enabled.url("/api/health?scope=bridge"), {
        headers: { cookie: `ovis_device=${WATCH_TOKEN}`, "x-forwarded-for": "100.64.0.9" },
      })
    ).json() as Record<string, unknown>;
    expect(watch["agent_queue"]).toBe(true);

    const disabled = startQueueServer({ withQueue: false });
    const disabledBody = await (
      await fetch(disabled.url("/api/health?scope=bridge"), { headers: { authorization: `Bearer ${BROWSER_TOKEN}` } })
    ).json() as Record<string, unknown>;
    expect(disabledBody["agent_queue"]).toBeUndefined();
  });

  it("enforces auth, bridgeToken isolation, same-origin, watch read-only, and 501 when unsupported", async () => {
    const ctx = startQueueServer({ withQueue: true });
    const project = join(ctx.root, "proj");
    mkdirSync(project);

    // Unauthenticated & bridgeToken rejected
    expect((await fetch(ctx.url("/api/queue"))).status).toBe(401);
    expect((await fetch(ctx.url("/api/queue"), { headers: { authorization: `Bearer ${BRIDGE_TOKEN}` } })).status).toBe(401);

    // Cross-origin mutations rejected by outer guard
    const evilPost = await fetch(ctx.url("/api/queue/tasks"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${BROWSER_TOKEN}`,
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ folder: project, prompt: "hello" }),
    });
    expect([evilPost.status, ((await evilPost.json()) as { error: { code: string } }).error.code]).toEqual([403, "invalid_origin"]);

    // Seed one task as owner
    const createdRes = await fetch(ctx.url("/api/queue/tasks"), {
      method: "POST",
      headers: ctx.authHeaders(BROWSER_TOKEN, { "content-type": "application/json" }),
      body: JSON.stringify({ folder: project, prompt: "Inspect logs" }),
    });
    expect(createdRes.status).toBe(201);
    const createdBody = (await createdRes.json()) as { task: QueueTask; queue: QueueSnapshot };

    // Watch device can GET /api/queue, but cannot mutate any queue route
    const watchGet = await fetch(ctx.url("/api/queue"), { headers: ctx.watchHeaders() });
    expect(watchGet.status).toBe(200);
    expect(((await watchGet.json()) as QueueSnapshot).tasks).toHaveLength(1);

    for (const [method, path, body] of [
      ["POST", "/api/queue/tasks", { folder: project, prompt: "forbidden" }],
      ["PATCH", `/api/queue/tasks/${createdBody.task.id}`, { hold: true }],
      ["DELETE", `/api/queue/tasks/${createdBody.task.id}`, undefined],
      ["POST", `/api/queue/tasks/${createdBody.task.id}/start`, undefined],
      ["POST", "/api/queue/reorder", { id: createdBody.task.id, direction: "up" }],
      ["PATCH", "/api/queue/settings", { paused: true }],
    ] as const) {
      const res = await fetch(ctx.url(path), {
        method,
        headers: ctx.watchHeaders(body ? { "content-type": "application/json" } : {}),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const err = (await res.json()) as { error: { code: string } };
      expect([path, res.status, err.error.code]).toEqual([path, 403, "read_only"]);
    }

    // herdr runtime (agentQueue: null) answers 501 unsupported
    const disabled = startQueueServer({ withQueue: false });
    for (const [method, path] of [
      ["GET", "/api/queue"],
      ["POST", "/api/queue/tasks"],
      ["PATCH", "/api/queue/tasks/t1"],
      ["DELETE", "/api/queue/tasks/t1"],
      ["POST", "/api/queue/tasks/t1/start"],
      ["POST", "/api/queue/reorder"],
      ["PATCH", "/api/queue/settings"],
    ] as const) {
      const res = await fetch(disabled.url(path), {
        method,
        headers: disabled.authHeaders(),
      });
      const err = (await res.json()) as { error: { code: string } };
      expect([method, path, res.status, err.error.code]).toEqual([method, path, 501, "unsupported"]);
    }
  });

  it("supports full CRUD, reorder, settings updates, start now, and proper error codes", async () => {
    const ctx = startQueueServer({ withQueue: true });
    const projA = join(ctx.root, "proj-a");
    const projB = join(ctx.root, "proj-b");
    mkdirSync(projA);
    mkdirSync(projB);

    const initialRes = await fetch(ctx.url("/api/queue"), { headers: ctx.authHeaders() });
    expect(initialRes.status).toBe(200);
    expect(initialRes.headers.get("cache-control")).toBe("no-store");
    const initial = (await initialRes.json()) as QueueSnapshot;
    expect(initial.tasks).toEqual([]);
    expect(initial.gate.status).toBe("idle");

    // Validation errors on create
    for (const badBody of [
      "not json",
      JSON.stringify([]),
      JSON.stringify({ prompt: "missing folder" }),
      JSON.stringify({ folder: projA, prompt: "   " }),
      JSON.stringify({ folder: projA, prompt: "ok", agent: "Bad Agent!" }),
      JSON.stringify({ folder: projA, prompt: "ok", hold: "yes" }),
    ]) {
      const res = await fetch(ctx.url("/api/queue/tasks"), {
        method: "POST",
        headers: ctx.authHeaders(BROWSER_TOKEN, { "content-type": "application/json" }),
        body: badBody,
      });
      expect(res.status).toBe(400);
    }

    // Create two tasks in projA and one in projB
    const postTask = async (payload: Record<string, unknown>) =>
      fetch(ctx.url("/api/queue/tasks"), {
        method: "POST",
        headers: ctx.authHeaders(BROWSER_TOKEN, { "content-type": "application/json" }),
        body: JSON.stringify(payload),
      });

    const t1Res = await postTask({ folder: `${projA}/`, prompt: "First task in A\nMore details", agent: "claude" });
    expect(t1Res.status).toBe(201);
    const { task: t1 } = (await t1Res.json()) as { task: QueueTask };
    expect(t1.folder).toBe(projA);
    expect(t1.title).toBe("First task in A");
    expect(t1.hold).toBe(false);

    const t2Res = await postTask({ folder: projA, title: "Custom B", prompt: "Second task in A", agent: "codex", hold: true });
    expect(t2Res.status).toBe(201);
    const { task: t2 } = (await t2Res.json()) as { task: QueueTask };

    const t3Res = await postTask({ folder: projB, prompt: "Task in B" });
    expect(t3Res.status).toBe(201);
    const { task: t3, queue: afterCreate } = (await t3Res.json()) as { task: QueueTask; queue: QueueSnapshot };
    expect(afterCreate.tasks.map((t) => t.id)).toEqual([t1.id, t2.id, t3.id]);
    expect(afterCreate.gate.status).toBe("ready");

    // Reorder inside projA using { id, direction: "up" } then { folder, orderedIds }
    const moveUp = await fetch(ctx.url("/api/queue/reorder"), {
      method: "POST",
      headers: ctx.authHeaders(BROWSER_TOKEN, { "content-type": "application/json" }),
      body: JSON.stringify({ id: t2.id, direction: "up" }),
    });
    expect(moveUp.status).toBe(200);
    expect(((await moveUp.json()) as { queue: QueueSnapshot }).queue.tasks.map((t) => t.id)).toEqual([t2.id, t1.id, t3.id]);

    const ordered = await fetch(ctx.url("/api/queue/reorder"), {
      method: "POST",
      headers: ctx.authHeaders(BROWSER_TOKEN, { "content-type": "application/json" }),
      body: JSON.stringify({ folder: projA, orderedIds: [t1.id, t2.id] }),
    });
    expect(ordered.status).toBe(200);
    expect(((await ordered.json()) as { queue: QueueSnapshot }).queue.tasks.map((t) => t.id)).toEqual([t1.id, t2.id, t3.id]);

    // Edit task
    const patchRes = await fetch(ctx.url(`/api/queue/tasks/${t2.id}`), {
      method: "PATCH",
      headers: ctx.authHeaders(BROWSER_TOKEN, { "content-type": "application/json" }),
      body: JSON.stringify({ hold: false, title: "Edited B" }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { task: QueueTask };
    expect(patched.task.hold).toBe(false);
    expect(patched.task.title).toBe("Edited B");

    // Settings update & gate evaluation
    const settingsRes = await fetch(ctx.url("/api/queue/settings"), {
      method: "PATCH",
      headers: ctx.authHeaders(BROWSER_TOKEN, { "content-type": "application/json" }),
      body: JSON.stringify({ paused: true, minMemMb: 3072, maxWorking: 4, cooldownSec: 90 }),
    });
    expect(settingsRes.status).toBe(200);
    const settingsBody = (await settingsRes.json()) as { queue: QueueSnapshot };
    expect(settingsBody.queue.gate.status).toBe("paused");
    expect(settingsBody.queue.gate.summary).toBe("Paused");
    expect(settingsBody.queue.settings).toEqual({ paused: true, minMemMb: 3072, maxWorking: 4, cooldownSec: 90 });

    const badSettings = await fetch(ctx.url("/api/queue/settings"), {
      method: "PATCH",
      headers: ctx.authHeaders(BROWSER_TOKEN, { "content-type": "application/json" }),
      body: JSON.stringify({ maxWorking: 0 }),
    });
    expect(badSettings.status).toBe(400);

    // Start Now launches t1 even while paused, and blocks starting t2 in same project (project_busy)
    const start1 = await fetch(ctx.url(`/api/queue/tasks/${t1.id}/start`), {
      method: "POST",
      headers: ctx.authHeaders(),
    });
    expect(start1.status).toBe(200);
    const start1Body = (await start1.json()) as { task: QueueTask; queue: QueueSnapshot };
    expect(start1Body.task.status).toBe("running");
    expect(start1Body.task.terminal).toBe("hc:queue-1");
    expect(ctx.startedPrompts).toEqual([{ paneId: "hc:queue-1", prompt: "First task in A\nMore details" }]);

    // Starting t1 again fails with task_not_queued (409)
    const startAgain = await fetch(ctx.url(`/api/queue/tasks/${t1.id}/start`), {
      method: "POST",
      headers: ctx.authHeaders(),
    });
    expect([startAgain.status, ((await startAgain.json()) as { error: { code: string } }).error.code]).toEqual([409, "task_not_queued"]);

    // Starting t2 while t1 is running fails with project_busy (409)
    const startSibling = await fetch(ctx.url(`/api/queue/tasks/${t2.id}/start`), {
      method: "POST",
      headers: ctx.authHeaders(),
    });
    expect([startSibling.status, ((await startSibling.json()) as { error: { code: string } }).error.code]).toEqual([409, "project_busy"]);

    // Deleting running task fails with 409 task_running
    const delRunning = await fetch(ctx.url(`/api/queue/tasks/${t1.id}`), {
      method: "DELETE",
      headers: ctx.authHeaders(),
    });
    expect([delRunning.status, ((await delRunning.json()) as { error: { code: string } }).error.code]).toEqual([409, "task_running"]);

    // Complete t1 via status hook, then requeue it cleanly
    ctx.agentQueue!.onPaneStatus("hc:queue-1", "done", "claude");
    const requeueRes = await fetch(ctx.url(`/api/queue/tasks/${t1.id}`), {
      method: "PATCH",
      headers: ctx.authHeaders(BROWSER_TOKEN, { "content-type": "application/json" }),
      body: JSON.stringify({ status: "queued" }),
    });
    expect(requeueRes.status).toBe(200);
    const requeued = ((await requeueRes.json()) as { task: QueueTask }).task;
    expect(requeued.status).toBe("queued");
    expect(requeued.terminal).toBeNull();

    // Delete queued task
    const delRes = await fetch(ctx.url(`/api/queue/tasks/${t3.id}`), {
      method: "DELETE",
      headers: ctx.authHeaders(),
    });
    expect(delRes.status).toBe(200);
    expect(((await delRes.json()) as { queue: QueueSnapshot }).queue.tasks.map((t) => t.id)).toEqual([t1.id, t2.id]);

    // 404s and 405s and unknown nested routes
    expect((await fetch(ctx.url("/api/queue/tasks/missing"), { method: "DELETE", headers: ctx.authHeaders() })).status).toBe(404);
    expect((await fetch(ctx.url("/api/queue/tasks/missing/start"), { method: "POST", headers: ctx.authHeaders() })).status).toBe(404);
    expect((await fetch(ctx.url("/api/queue"), { method: "POST", headers: ctx.authHeaders() })).status).toBe(405);
    expect((await fetch(ctx.url("/api/queue/tasks"), { method: "GET", headers: ctx.authHeaders() })).status).toBe(405);
    expect((await fetch(ctx.url("/api/queue/reorder"), { method: "GET", headers: ctx.authHeaders() })).status).toBe(405);
    expect((await fetch(ctx.url("/api/queue/settings"), { method: "GET", headers: ctx.authHeaders() })).status).toBe(405);
    expect((await fetch(ctx.url(`/api/queue/tasks/${t1.id}`), { method: "GET", headers: ctx.authHeaders() })).status).toBe(405);
    expect((await fetch(ctx.url(`/api/queue/tasks/${t1.id}/start`), { method: "GET", headers: ctx.authHeaders() })).status).toBe(405);
    expect((await fetch(ctx.url("/api/queue/unknown"), { headers: ctx.authHeaders() })).status).toBe(404);
  });

  it("streams initial and live agent-queue updates on both /ws machine-events and /api/machines/events SSE", async () => {
    const ctx = startQueueServer({ withQueue: true });
    const project = join(ctx.root, "proj-live");
    mkdirSync(project);

    const client = await wsClient(ctx.base);
    const abort = new AbortController();
    const sseEvents: MachineEvent[] = [];
    let sseBuffer = "";

    const sseResponse = await fetch(ctx.url("/api/machines/events"), {
      headers: { authorization: `Bearer ${BROWSER_TOKEN}` },
      signal: abort.signal,
    });
    expect(sseResponse.status).toBe(200);
    const reader = sseResponse.body!.getReader();
    const decoder = new TextDecoder();

    const readSseUntil = async (predicate: (event: MachineEvent) => boolean): Promise<MachineEvent> => {
      for (;;) {
        const hit = sseEvents.find(predicate);
        if (hit) return hit;
        const { value, done } = await reader.read();
        if (done) throw new Error("SSE stream closed unexpectedly");
        sseBuffer += decoder.decode(value, { stream: true });
        for (let sep = sseBuffer.indexOf("\n\n"); sep >= 0; sep = sseBuffer.indexOf("\n\n")) {
          const frame = sseBuffer.slice(0, sep);
          sseBuffer = sseBuffer.slice(sep + 2);
          if (frame.startsWith("data: ")) {
            sseEvents.push(JSON.parse(frame.slice(6)) as MachineEvent);
          }
        }
      }
    };

    try {
      client.socket.send(JSON.stringify({ type: "machine-events", enabled: true }));
      const initialWs = await client.wait(
        (frame): frame is Extract<ServerMessage, { type: "machine-event" }> =>
          frame.type === "machine-event" && frame.event.type === "agent-queue",
      );
      expect(initialWs.event.type === "agent-queue" && initialWs.event.queue.tasks).toEqual([]);

      const initialSse = await readSseUntil((event) => event.type === "agent-queue");
      expect(initialSse.type === "agent-queue" && initialSse.queue.tasks).toEqual([]);

      const post = await fetch(ctx.url("/api/queue/tasks"), {
        method: "POST",
        headers: ctx.authHeaders(BROWSER_TOKEN, { "content-type": "application/json" }),
        body: JSON.stringify({ folder: project, prompt: "Push live event" }),
      });
      expect(post.status).toBe(201);

      const updatedWs = await client.wait(
        (frame): frame is Extract<ServerMessage, { type: "machine-event" }> =>
          frame.type === "machine-event" && frame.event.type === "agent-queue" && frame.event.queue.tasks.length === 1,
      );
      expect(updatedWs.event.type === "agent-queue" && updatedWs.event.queue.tasks[0]?.title).toBe("Push live event");

      const updatedSse = await readSseUntil((event) => event.type === "agent-queue" && event.queue.tasks.length === 1);
      expect(updatedSse.type === "agent-queue" && updatedSse.queue.tasks[0]?.title).toBe("Push live event");
    } finally {
      abort.abort();
      await reader.cancel().catch(() => undefined);
      client.socket.close();
    }
  });
});
