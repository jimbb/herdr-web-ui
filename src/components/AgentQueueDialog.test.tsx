import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { DEFAULT_QUEUE_SETTINGS, type QueueSnapshot, type QueueTask } from "../../shared/agent-queue.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { AgentQueueDialog, QueueFootEntry } from "./AgentQueueDialog.tsx";

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : textOf(child)))
    .join("");
}

function makeTask(partial: Partial<QueueTask> & Pick<QueueTask, "id" | "folder" | "prompt">): QueueTask {
  return {
    title: partial.title ?? partial.prompt.slice(0, 60),
    agent: partial.agent ?? "claude",
    hold: partial.hold ?? false,
    status: partial.status ?? "queued",
    terminal: partial.terminal ?? null,
    createdAt: partial.createdAt ?? "2026-11-18T00:00:00.000Z",
    startedAt: partial.startedAt ?? null,
    finishedAt: partial.finishedAt ?? null,
    error: partial.error ?? null,
    ...partial,
  };
}

function makeSnapshot(partial: Partial<QueueSnapshot> = {}): QueueSnapshot {
  return {
    version: 1,
    settings: { ...DEFAULT_QUEUE_SETTINGS, ...(partial.settings ?? {}) },
    lastLaunchAt: partial.lastLaunchAt ?? null,
    tasks: partial.tasks ?? [],
    gate: partial.gate ?? {
      status: "idle",
      summary: "Idle",
      memAvailableMb: 12_288,
      workingCount: 0,
      cooldownLeftSec: 0,
    },
  };
}

function renderStatic(node: ReactElement): string {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en-US"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, null, node));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("QueueFootEntry", () => {
  it("renders Agent Queue and accurate status badge across states", () => {
    expect(renderStatic(createElement(QueueFootEntry, { snapshot: null, onOpen: () => {} }))).toContain("Agent Queue");
    expect(renderStatic(createElement(QueueFootEntry, { snapshot: makeSnapshot(), onOpen: () => {} }))).not.toContain("sidebar-footer-pc-action");

    const queuedOnly = renderStatic(
      createElement(QueueFootEntry, {
        snapshot: makeSnapshot({
          tasks: [
            makeTask({ id: "t1", folder: "/proj/a", prompt: "First" }),
            makeTask({ id: "t2", folder: "/proj/a", prompt: "Second", hold: true }),
          ],
        }),
        onOpen: () => {},
      }),
    );
    expect(queuedOnly).toContain("2 queued");
    expect(queuedOnly).toContain("is-active");

    const runningMarkup = renderStatic(
      createElement(QueueFootEntry, {
        snapshot: makeSnapshot({
          tasks: [
            makeTask({ id: "t1", folder: "/proj/a", prompt: "Run", status: "running", terminal: "p1" }),
            makeTask({ id: "t2", folder: "/proj/b", prompt: "Wait" }),
          ],
        }),
        onOpen: () => {},
      }),
    );
    expect(runningMarkup).toContain("1 running · 1 queued");
    expect(runningMarkup).toContain("is-active");

    const pausedMarkup = renderStatic(
      createElement(QueueFootEntry, {
        snapshot: makeSnapshot({
          settings: { ...DEFAULT_QUEUE_SETTINGS, paused: true },
          tasks: [
            makeTask({ id: "t1", folder: "/proj/a", prompt: "Run", status: "running", terminal: "p1" }),
            makeTask({ id: "t2", folder: "/proj/a", prompt: "Next" }),
          ],
        }),
        onOpen: () => {},
      }),
    );
    expect(pausedMarkup).toContain("Paused · 1 queued");
    expect(pausedMarkup).toContain("is-paused");
  });
});

describe("AgentQueueDialog", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const stored = new Map<string, string>();
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "localStorage", "HTMLElement", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    stored.clear();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    };
    const events = new EventTarget();
    const media = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define("IS_REACT_ACT_ENVIRONMENT", true);
    define("HTMLElement", class HTMLElement {});
    define("ResizeObserver", class ResizeObserver { observe() {} unobserve() {} disconnect() {} });
    define("localStorage", storage);
    define("navigator", { languages: ["en-US"], platform: "Linux" });
    define("window", {
      localStorage: storage,
      matchMedia: media,
      location: { protocol: "http:", hostname: "localhost", origin: "http://localhost:7317" },
      innerWidth: 1280,
      innerHeight: 800,
      history: { state: null, pushState() {}, replaceState() {}, back() {} },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      requestAnimationFrame: () => 1,
      cancelAnimationFrame() {},
      setTimeout,
      clearTimeout,
    });
    define("document", {
      visibilityState: "visible",
      activeElement: null,
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    });
    define("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  function mockQueueFetch(initial: QueueSnapshot, handler?: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const spy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const rawBody = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      if (url.includes("/api/queue")) requests.push({ url, method, body: rawBody });
      if (url.includes("/api/agents")) {
        return Response.json({ agents: [{ kind: "claude", label: "Claude" }, { kind: "codex", label: "Codex" }] });
      }
      if (handler) return handler(url, init);
      return Response.json(initial);
    }, globalThis.fetch));
    return { spy, requests };
  }

  async function renderDialog(opts: {
    open?: boolean;
    snapshot: QueueSnapshot | null;
    watching?: boolean;
    defaultFolder?: string | null;
    onClose?: () => void;
    onChange?: (next: QueueSnapshot) => void;
    onOpenPane?: (paneId: string) => void;
  }) {
    await act(async () => {
      renderer = create(
        createElement(
          SettingsProvider,
          null,
          createElement(
            MachineContext.Provider,
            { value: "local" },
            createElement(AgentQueueDialog, {
              open: opts.open ?? true,
              snapshot: opts.snapshot,
              watching: opts.watching ?? false,
              defaultFolder: opts.defaultFolder ?? null,
              onClose: opts.onClose ?? (() => {}),
              onChange: opts.onChange ?? (() => {}),
              onOpenPane: opts.onOpenPane ?? (() => {}),
            }),
          ),
        ),
      );
    });
    await flushMicrotasks();
  }

  it("renders nothing when closed", async () => {
    const snap = makeSnapshot();
    const { spy } = mockQueueFetch(snap);
    try {
      await renderDialog({ open: false, snapshot: snap });
      expect(renderer!.toJSON()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("validates empty task form fields and creates a task via POST /api/queue/tasks", async () => {
    const empty = makeSnapshot();
    const afterCreate = makeSnapshot({
      tasks: [makeTask({ id: "created-1", folder: "/work/app", title: "Ship queue", prompt: "Implement tests" })],
      gate: { status: "ready", summary: "Ready", memAvailableMb: 12_288, workingCount: 0, cooldownLeftSec: 0 },
    });
    const changes: QueueSnapshot[] = [];
    const { spy, requests } = mockQueueFetch(empty, (url, init) => {
      if (url.endsWith("/api/queue/tasks") && init?.method === "POST") {
        return Response.json({ task: afterCreate.tasks[0], queue: afterCreate }, { status: 201 });
      }
      return Response.json(empty);
    });
    try {
      await renderDialog({
        snapshot: empty,
        onChange: (next) => changes.push(next),
      });

      const emptyTitle = renderer!.root.findByProps({ className: "queue-empty-title" });
      expect(textOf(emptyTitle)).toBe("No queued tasks yet");
      expect(textOf(renderer!.root.findByProps({ className: "queue-gate-summary" }))).toBe("Idle — no runnable tasks");

      const addButton = renderer!.root.findByProps({ className: "btn btn-primary queue-add-btn" });
      await act(async () => { addButton.props.onClick(); });

      const form = renderer!.root.findByProps({ className: "queue-editor-form" });
      await act(async () => { await form.props.onSubmit({ preventDefault() {} }); });
      expect(textOf(renderer!.root.findByProps({ className: "queue-error" }))).toBe("Enter a project folder.");

      const folderInput = renderer!.root.findByProps({ id: "queue-task-folder" });
      await act(async () => { folderInput.props.onChange({ target: { value: "/work/app/" } }); });
      await act(async () => { await renderer!.root.findByProps({ className: "queue-editor-form" }).props.onSubmit({ preventDefault() {} }); });
      expect(textOf(renderer!.root.findByProps({ className: "queue-error" }))).toBe("Enter a prompt for the agent.");

      const promptInput = renderer!.root.findByProps({ className: "input queue-prompt-input" });
      const titleInput = renderer!.root.findAll((node) => node.type === "input" && node.props.autoComplete === "off")[1]!;
      await act(async () => {
        titleInput.props.onChange({ target: { value: "Ship queue" } });
        promptInput.props.onChange({ target: { value: "Implement tests" } });
      });

      await act(async () => { await renderer!.root.findByProps({ className: "queue-editor-form" }).props.onSubmit({ preventDefault() {} }); });
      await flushMicrotasks();

      const post = requests.find((req) => req.method === "POST" && req.url.endsWith("/api/queue/tasks"));
      expect(post?.body).toEqual({
        folder: "/work/app",
        title: "Ship queue",
        prompt: "Implement tests",
        agent: "claude",
        hold: false,
      });
      expect(changes.at(-1)).toEqual(afterCreate);
    } finally {
      spy.mockRestore();
    }
  });

  it("renders grouped project cards, handles task actions, prompt expand, pause, and settings validation", async () => {
    const longPrompt = "A".repeat(160);
    const snapshot = makeSnapshot({
      tasks: [
        makeTask({ id: "t-run", folder: "/repo/alpha", title: "Running job", prompt: "Fix build", status: "running", terminal: "pane-alpha" }),
        makeTask({ id: "t-queued", folder: "/repo/alpha", title: "Queued long", prompt: longPrompt, status: "queued" }),
        makeTask({ id: "t-failed", folder: "/repo/beta", title: "Failed job", prompt: "Run lint", status: "failed", error: "Exit code 1" }),
        makeTask({ id: "t-beta-first", folder: "/repo/beta", title: "First beta job", prompt: "Check types", agent: "codex", status: "queued" }),
        makeTask({ id: "t-ready", folder: "/repo/beta", title: "Ready job", prompt: "Add docs", agent: "codex", status: "queued" }),
      ],
      gate: { status: "cooldown", summary: "Cooldown 45s", memAvailableMb: 8_192, workingCount: 1, cooldownLeftSec: 45 },
    });

    const openedPanes: string[] = [];
    const changes: QueueSnapshot[] = [];
    const { spy, requests } = mockQueueFetch(snapshot, (url, init) => {
      if (url.endsWith("/api/queue/settings") && init?.method === "PATCH") {
        return Response.json({ settings: { ...snapshot.settings, minMemMb: 4096 }, queue: snapshot });
      }
      if (url.endsWith("/api/queue/tasks/t-ready/start") && init?.method === "POST") {
        return Response.json({ task: snapshot.tasks.find((t) => t.id === "t-ready")!, queue: snapshot });
      }
      if (url.endsWith("/api/queue/reorder") && init?.method === "POST") {
        return Response.json({ tasks: snapshot.tasks, queue: snapshot });
      }
      if (url.includes("/api/queue/tasks/") && init?.method === "PATCH") {
        return Response.json({ task: snapshot.tasks.find((t) => t.id === "t-queued")!, queue: snapshot });
      }
      if (url.includes("/api/queue/tasks/") && init?.method === "DELETE") {
        return Response.json({ ok: true, queue: snapshot });
      }
      return Response.json(snapshot);
    });

    try {
      await renderDialog({
        snapshot,
        onChange: (next) => changes.push(next),
        onOpenPane: (paneId) => openedPanes.push(paneId),
      });

      const projectCards = renderer!.root.findAllByProps({ className: "queue-project-card" });
      expect(projectCards).toHaveLength(2);
      expect(textOf(projectCards[0]!.findByProps({ className: "queue-project-name" }))).toBe("alpha");
      expect(textOf(projectCards[1]!.findByProps({ className: "queue-project-name" }))).toBe("beta");

      // Inside beta, queued tasks sort ahead of the failed task.
      expect(
        projectCards[1]!.findAll((node) => node.type === "li").map((row) => textOf(row.findByProps({ className: "queue-task-title" }))),
      ).toEqual(["First beta job", "Ready job", "Failed job"]);

      // Gate summary and pills
      expect(textOf(renderer!.root.findByProps({ className: "queue-gate-summary" }))).toBe("Cooldown 45s");
      const pills = renderer!.root.findAllByProps({ className: "pill" }).map(textOf);
      expect(pills).toEqual(["Free RAM 8 GB (min 2 GB)", "Working 1/6", "Cooldown 45s"]);

      // Open tab button
      const openTabButton = renderer!.root.findByProps({ className: "btn queue-open-tab" });
      await act(async () => { openTabButton.props.onClick(); });
      expect(openedPanes).toEqual(["pane-alpha"]);

      // Prompt expand/collapse toggle
      const expandToggle = renderer!.root.findByProps({ className: "queue-prompt-toggle" });
      expect(textOf(expandToggle)).toBe("Show full prompt");
      await act(async () => { expandToggle.props.onClick(); });
      expect(textOf(renderer!.root.findByProps({ className: "queue-prompt-toggle" }))).toBe("Hide full prompt");
      expect(renderer!.root.findAllByProps({ className: "queue-task-prompt is-expanded" })).toHaveLength(1);

      // Failed task error is visible
      expect(textOf(renderer!.root.findByProps({ className: "queue-task-error" }))).toBe("Exit code 1");

      // Start now is disabled in alpha (sibling running), enabled in beta (failed sibling only)
      const startButtons = renderer!.root.findAll((node) => node.type === "button" && textOf(node) === "Start now");
      expect(startButtons).toHaveLength(3);
      expect(startButtons[0]!.props.disabled).toBe(true);
      expect(startButtons[0]!.props.title).toBe("Another task is already running in this project");
      expect(startButtons[1]!.props.disabled).toBe(false);
      expect(startButtons[2]!.props.disabled).toBe(false);

      await act(async () => { await startButtons[2]!.props.onClick(); });
      expect(requests.some((req) => req.method === "POST" && req.url.endsWith("/api/queue/tasks/t-ready/start"))).toBe(true);

      // Reorder up/down bounds ignore non-queued siblings (running above in alpha, failed below in beta)
      const moveUpButtons = renderer!.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Move up");
      const moveDownButtons = renderer!.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Move down");
      expect(moveUpButtons.map((btn) => btn.props.disabled)).toEqual([true, true, false]);
      expect(moveDownButtons.map((btn) => btn.props.disabled)).toEqual([true, false, true]);
      await act(async () => { await moveUpButtons[2]!.props.onClick(); });
      expect(requests.find((req) => req.url.endsWith("/api/queue/reorder"))?.body).toEqual({ id: "t-ready", direction: "up" });

      // Hold toggle
      const holdButtons = renderer!.root.findAll((node) => node.type === "button" && textOf(node) === "Hold");
      await act(async () => { await holdButtons[0]!.props.onClick(); });
      expect(requests.find((req) => req.method === "PATCH" && req.url.endsWith("/api/queue/tasks/t-queued"))?.body).toEqual({ hold: true });

      // Requeue failed task
      const requeueButton = renderer!.root.find((node) => node.type === "button" && textOf(node) === "Requeue");
      await act(async () => { await requeueButton.props.onClick(); });
      expect(requests.find((req) => req.method === "PATCH" && req.url.endsWith("/api/queue/tasks/t-failed"))?.body).toEqual({ status: "queued" });

      // Edit task form
      const editButtons = renderer!.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Edit");
      expect(editButtons.length).toBe(4); // queued, beta-first, ready, failed (not running)
      await act(async () => { editButtons[0]!.props.onClick(); });
      expect(textOf(renderer!.root.findByProps({ className: "modal-title" }))).toBe("Edit queued task");
      const editPrompt = renderer!.root.findByProps({ className: "input queue-prompt-input" });
      await act(async () => { editPrompt.props.onChange({ target: { value: "Updated prompt" } }); });
      await act(async () => { await renderer!.root.findByProps({ className: "queue-editor-form" }).props.onSubmit({ preventDefault() {} }); });
      await flushMicrotasks();
      expect(requests.filter((req) => req.method === "PATCH" && req.url.endsWith("/api/queue/tasks/t-queued")).at(-1)?.body).toEqual({
        folder: "/repo/alpha",
        title: "Queued long",
        prompt: "Updated prompt",
        agent: "claude",
        hold: false,
      });

      // Delete task
      const deleteButtons = renderer!.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Delete");
      await act(async () => { await deleteButtons[2]!.props.onClick(); });
      expect(requests.some((req) => req.method === "DELETE" && req.url.endsWith("/api/queue/tasks/t-ready"))).toBe(true);

      // Pause button
      const pauseButton = renderer!.root.findByProps({ className: "btn queue-pause-btn" });
      await act(async () => { await pauseButton.props.onClick(); });
      expect(requests.find((req) => req.method === "PATCH" && req.url.endsWith("/api/queue/settings"))?.body).toEqual({ paused: true });

      // Open settings panel and verify validation
      const settingsButton = renderer!.root.find((node) => node.type === "button" && node.props["aria-label"] === "Queue settings");
      await act(async () => { settingsButton.props.onClick(); });
      const minMemInput = renderer!.root.findAll((node) => node.type === "input" && node.props.type === "number")[0]!;
      await act(async () => { minMemInput.props.onChange({ target: { value: "-5" } }); });
      await act(async () => { await renderer!.root.findByProps({ className: "queue-settings-panel" }).props.onSubmit({ preventDefault() {} }); });
      expect(textOf(renderer!.root.findByProps({ className: "queue-error" }))).toContain("Enter non-negative numbers");

      await act(async () => { minMemInput.props.onChange({ target: { value: "4096" } }); });
      await act(async () => { await renderer!.root.findByProps({ className: "queue-settings-panel" }).props.onSubmit({ preventDefault() {} }); });
      const settingsPatches = requests.filter((req) => req.method === "PATCH" && req.url.endsWith("/api/queue/settings"));
      expect(settingsPatches.at(-1)?.body).toEqual({ minMemMb: 4096, maxWorking: 6, cooldownSec: 180 });

      expect(changes.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("renders Needs you badge when a running task is blocked waiting on input, plus Agent exited failures", async () => {
    const snapshot = makeSnapshot({
      tasks: [
        makeTask({
          id: "t-needs",
          folder: "/repo/wait",
          title: "Needs input run",
          prompt: "Reply with just: QUEUE OK",
          status: "running",
          needsInput: true,
          terminal: "pane-needs",
        }),
        makeTask({
          id: "t-plain",
          folder: "/repo/run",
          title: "Plain run",
          prompt: "Work normally",
          status: "running",
          terminal: "pane-plain",
        }),
        makeTask({
          id: "t-exited",
          folder: "/repo/exit",
          title: "Exited run",
          prompt: "Exited task",
          status: "failed",
          terminal: "pane-exited",
          error: "Agent exited",
        }),
      ],
    });
    const { spy } = mockQueueFetch(snapshot);
    try {
      await renderDialog({ snapshot });
      const rows = renderer!.root.findAll((node) => node.type === "li");
      expect(rows).toHaveLength(3);

      expect(rows[0]!.props.className).toContain("is-running");
      expect(rows[0]!.props.className).toContain("is-needs-input");
      expect(textOf(rows[0]!.findByProps({ className: "badge queue-badge-needs" }))).toBe("Needs you");

      expect(rows[1]!.props.className).not.toContain("is-needs-input");
      expect(textOf(rows[1]!.findByProps({ className: "badge badge-working" }))).toBe("Running");

      expect(textOf(rows[2]!.findByProps({ className: "badge badge-blocked" }))).toBe("Failed");
      expect(textOf(rows[2]!.findByProps({ className: "queue-task-error" }))).toBe("Agent exited");
    } finally {
      spy.mockRestore();
    }
  });

  it("hides all mutating controls when watching is true", async () => {
    const snapshot = makeSnapshot({
      tasks: [
        makeTask({ id: "t-run", folder: "/repo/alpha", prompt: "Fix build", status: "running", terminal: "pane-alpha" }),
        makeTask({ id: "t-q", folder: "/repo/alpha", prompt: "Next task", status: "queued" }),
      ],
    });
    const { spy } = mockQueueFetch(snapshot);
    try {
      await renderDialog({ snapshot, watching: true });
      expect(textOf(renderer!.root.findByProps({ className: "queue-notice" }))).toBe("View only: queue changes are disabled on this device.");
      expect(renderer!.root.findAllByProps({ className: "btn btn-primary queue-add-btn" })).toHaveLength(0);
      expect(renderer!.root.findAllByProps({ className: "btn queue-pause-btn" })).toHaveLength(0);
      expect(renderer!.root.findAllByProps({ className: "icon-button queue-delete-btn" })).toHaveLength(0);
      expect(renderer!.root.findAll((node) => node.type === "button" && ["Add task", "Start now", "Hold", "Pause"].includes(textOf(node)))).toHaveLength(0);
      expect(renderer!.root.findAllByProps({ className: "btn queue-open-tab" })).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("places running and queued projects and tasks at the top above failed and done items", async () => {
    const snapshot = makeSnapshot({
      tasks: [
        makeTask({ id: "t-done-1", folder: "/repo/done-only", title: "Finished work", prompt: "Done 1", status: "done", terminal: "p1" }),
        makeTask({ id: "t-fail-1", folder: "/repo/failed-only", title: "Broken work", prompt: "Fail 1", status: "failed" }),
        makeTask({ id: "t-wait-done", folder: "/repo/queued-proj", title: "Old queued done", prompt: "Done 2", status: "done" }),
        makeTask({ id: "t-wait-q", folder: "/repo/queued-proj", title: "Next idle task", prompt: "Queued 1", status: "queued" }),
        makeTask({ id: "t-run-done", folder: "/repo/active-proj", title: "Earlier done", prompt: "Done 3", status: "done" }),
        makeTask({ id: "t-run-q", folder: "/repo/active-proj", title: "Waiting after run", prompt: "Queued 2", status: "queued" }),
        makeTask({ id: "t-run-live", folder: "/repo/active-proj", title: "Live running", prompt: "Run 1", status: "running", terminal: "p2" }),
      ],
    });
    const { spy } = mockQueueFetch(snapshot);
    try {
      await renderDialog({ snapshot });
      const cards = renderer!.root.findAllByProps({ className: "queue-project-card" });
      expect(cards.map((card) => textOf(card.findByProps({ className: "queue-project-name" })))).toEqual([
        "active-proj",
        "queued-proj",
        "failed-only",
        "done-only",
      ]);

      expect(
        cards[0]!.findAll((node) => node.type === "li").map((row) => textOf(row.findByProps({ className: "queue-task-title" }))),
      ).toEqual(["Live running", "Waiting after run", "Earlier done"]);
      expect(
        cards[1]!.findAll((node) => node.type === "li").map((row) => textOf(row.findByProps({ className: "queue-task-title" }))),
      ).toEqual(["Next idle task", "Old queued done"]);
    } finally {
      spy.mockRestore();
    }
  });
});
