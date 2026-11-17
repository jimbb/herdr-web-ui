import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ExternalLink,
  FolderOpen,
  ListOrdered,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";

import "./AgentQueueDialog.css";

import {
  DEFAULT_QUEUE_AGENT,
  DEFAULT_QUEUE_SETTINGS,
  formatQueueDuration,
  formatQueueGb,
  normalizeQueueFolder,
  queueFolderName,
  queueTaskTitleFallback,
  type QueueSnapshot,
  type QueueTask,
} from "../../shared/agent-queue.ts";
import type { AgentKind } from "../../shared/protocol.ts";
import {
  ApiError,
  createQueueTask,
  deleteQueueTask,
  fetchQueue,
  reorderQueueTasks,
  startQueueTask,
  updateQueueSettings,
  updateQueueTask,
} from "../lib/api.ts";
import {
  describeQueueGate,
  groupQueueTasksByFolder,
  isQueueGateWaiting,
  parseQueueSettingsDraft,
  queueBadgeCounts,
  queueFolderSuggestions,
  type QueueSettingsDraft,
} from "../lib/agentQueue.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { recentDirectories } from "../lib/recent-directories.ts";
import { agentName } from "../lib/runtimeMove.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { focusInOtherModal, nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { userErrorMessage } from "../lib/userError.ts";
import { AgentMark } from "./AgentMark.tsx";
import { AgentPicker } from "./AgentPicker.tsx";
import { DirectoryBrowser, homeRelative } from "./DirectoryBrowser.tsx";
import { RecentFolderChips } from "./RecentFolderChips.tsx";
import { Toggle } from "./SettingsControls.tsx";

export interface AgentQueueDialogProps {
  open: boolean;
  snapshot: QueueSnapshot | null;
  watching?: boolean;
  defaultFolder?: string | null;
  onClose: () => void;
  onChange: (next: QueueSnapshot) => void;
  onOpenPane: (paneId: string) => void;
}

type EditorState =
  | { mode: "create" }
  | { mode: "edit"; taskId: string };

/** The sidebar and mobile drawer footer button opening the local per-project agent task queue. */
export function QueueFootEntry({ snapshot, onOpen }: { snapshot: QueueSnapshot | null; onOpen(): void }) {
  const t = useT();
  const { running, queued, active, paused } = queueBadgeCounts(snapshot);
  const meta = paused
    ? t("Paused")
    : running > 0
      ? t("{count} running", { count: running })
      : queued > 0
        ? t("{count} queued", { count: queued })
        : null;
  return (
    <button
      type="button"
      className={`btn btn-ghost sidebar-footer-action sidebar-footer-pc queue-foot-entry${paused ? " is-paused" : active > 0 ? " is-active" : ""}`}
      onClick={onOpen}
    >
      <ListOrdered aria-hidden="true" />
      <span className="sidebar-footer-pc-name">{t("Agent Queue")}</span>
      {meta !== null && <span className="sidebar-footer-pc-action">{meta}</span>}
    </button>
  );
}

function fallbackAgents(currentKind: string): AgentKind[] {
  const kinds = currentKind && currentKind !== DEFAULT_QUEUE_AGENT
    ? [DEFAULT_QUEUE_AGENT, currentKind]
    : [DEFAULT_QUEUE_AGENT];
  return kinds.map((kind) => ({ kind, label: agentName(kind) }));
}

function mergeAgentsWithSelected(fetched: AgentKind[], selectedKind: string): AgentKind[] {
  const base = fetched.length > 0 ? fetched : fallbackAgents(selectedKind);
  if (!selectedKind || base.some((agent) => agent.kind === selectedKind)) return base;
  return [...base, { kind: selectedKind, label: agentName(selectedKind) }];
}

function statusBadgeClass(task: QueueTask): string {
  switch (task.status) {
    case "running": return task.needsInput ? "badge queue-badge-needs" : "badge badge-working";
    case "done": return "badge badge-done";
    case "failed": return "badge badge-blocked";
    case "queued": return task.hold ? "badge badge-unknown" : "badge badge-idle";
  }
}

export function AgentQueueDialog({
  open,
  snapshot,
  watching = false,
  defaultFolder = null,
  onClose,
  onChange,
  onOpenPane,
}: AgentQueueDialogProps) {
  const t = useT();
  const titleId = useId();
  const folderHintId = useId();
  const recentsId = useId();
  const agentLabelId = useId();
  const titleLabelId = useId();
  const promptLabelId = useId();
  const promptHintId = useId();
  const minMemId = useId();
  const maxWorkingId = useId();
  const cooldownId = useId();
  const { fetchAgentKinds } = useMachineApi();

  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentKind[]>(() => fallbackAgents(DEFAULT_QUEUE_AGENT));

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<QueueSettingsDraft>({
    minMemMb: String(DEFAULT_QUEUE_SETTINGS.minMemMb),
    maxWorking: String(DEFAULT_QUEUE_SETTINGS.maxWorking),
    cooldownSec: String(DEFAULT_QUEUE_SETTINGS.cooldownSec),
  });
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [folder, setFolder] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [agent, setAgent] = useState(DEFAULT_QUEUE_AGENT);
  const [hold, setHold] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [expandedPrompts, setExpandedPrompts] = useState<ReadonlySet<string>>(() => new Set());

  const folderInputRef = useRef<HTMLInputElement>(null);
  const promptInputRef = useRef<HTMLTextAreaElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const busy = busyKey !== null;

  const showFolderEnd = (): void => {
    const field = folderInputRef.current;
    if (field !== null) field.scrollLeft = field.scrollWidth;
  };

  useLayoutEffect(() => {
    if (open && editor !== null && document.activeElement !== folderInputRef.current) showFolderEnd();
  }, [open, editor, folder]);

  const closeEditor = (): void => {
    if (busy) return;
    setEditor(null);
    setBrowsing(false);
    setFormError(null);
  };

  const surface = useFocusTrap<HTMLDivElement>(open, { initialFocus: closeButtonRef });
  useSheetSwipe(surface, busy ? null : onClose);
  usePhoneSheetBack(() => {
    if (busy) return false;
    onClose();
  }, open);
  usePhoneSheetBack(() => {
    if (busy) return false;
    closeEditor();
  }, open && editor !== null);
  usePhoneSheetBack(() => setBrowsing(false), open && editor !== null && browsing);

  // Sync settings draft whenever settings drawer opens or snapshot settings arrive while panel closed.
  useEffect(() => {
    if (!snapshot || settingsOpen) return;
    setSettingsDraft({
      minMemMb: String(snapshot.settings.minMemMb),
      maxWorking: String(snapshot.settings.maxWorking),
      cooldownSec: String(snapshot.settings.cooldownSec),
    });
  }, [snapshot, settingsOpen]);

  // Fetch fresh queue state and local agent kinds whenever opened.
  useEffect(() => {
    if (!open) {
      setEditor(null);
      setBrowsing(false);
      setSettingsOpen(false);
      setFormError(null);
      setSettingsError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchQueue()
      .then((fresh) => {
        if (!cancelled) onChange(fresh);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        const msg = reason instanceof ApiError ? userErrorMessage(reason).message : t("Queue state could not be loaded.");
        setError(msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    void fetchAgentKinds()
      .then((list) => {
        if (!cancelled && list.length > 0) setAgents(list);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [open]);

  // Escape closes innermost subview first (DirectoryBrowser -> Task Editor -> Dialog).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current) || focusInOtherModal(surface.current)) return;
      event.preventDefault();
      if (busy) return;
      if (browsing) setBrowsing(false);
      else if (editor !== null) closeEditor();
      else onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, busy, browsing, editor, onClose, surface]);

  if (!open) return null;

  const recentFolders = queueFolderSuggestions(snapshot, defaultFolder, recentDirectories.read("local"));

  const runMutation = async (key: string, fn: () => Promise<QueueSnapshot>, onFormError?: (msg: string) => void): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusyKey(key);
    setError(null);
    if (onFormError) onFormError("");
    try {
      const next = await fn();
      onChange(next);
      return true;
    } catch (reason: unknown) {
      const msg = userErrorMessage(reason).message;
      if (onFormError) onFormError(msg);
      else setError(msg);
      return false;
    } finally {
      inFlight.current = false;
      setBusyKey(null);
    }
  };

  const openCreateForm = (prefillFolder?: string): void => {
    if (watching || busy) return;
    const pickedFolder = prefillFolder ?? recentFolders[0] ?? defaultFolder ?? "";
    setEditor({ mode: "create" });
    setFolder(pickedFolder);
    setTaskTitle("");
    setPrompt("");
    setAgent(DEFAULT_QUEUE_AGENT);
    setHold(false);
    setFormError(null);
    setBrowsing(false);
  };

  const openEditForm = (task: QueueTask): void => {
    if (watching || busy || task.status === "running") return;
    setEditor({ mode: "edit", taskId: task.id });
    setFolder(task.folder);
    const derived = queueTaskTitleFallback(task.prompt);
    setTaskTitle(task.title === derived ? "" : task.title);
    setPrompt(task.prompt);
    setAgent(task.agent || DEFAULT_QUEUE_AGENT);
    setHold(task.hold);
    setFormError(null);
    setBrowsing(false);
  };

  const refreshNow = async (): Promise<void> => {
    if (loading || busy) return;
    setLoading(true);
    setError(null);
    try {
      onChange(await fetchQueue());
    } catch (reason: unknown) {
      setError(userErrorMessage(reason).message);
    } finally {
      setLoading(false);
    }
  };

  const submitTask = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (watching || editor === null) return;
    const cleanFolder = normalizeQueueFolder(folder);
    if (!cleanFolder) {
      setFormError(t("Enter a project folder."));
      folderInputRef.current?.focus();
      return;
    }
    if (prompt.trim() === "") {
      setFormError(t("Enter a prompt for the agent."));
      promptInputRef.current?.focus();
      return;
    }
    const trimmedTitle = taskTitle.trim();
    const ok = editor.mode === "create"
      ? await runMutation(
          "submit",
          () => createQueueTask({
            folder: cleanFolder,
            ...(trimmedTitle ? { title: trimmedTitle } : {}),
            prompt,
            agent,
            hold,
          }),
          (msg) => setFormError(msg || null),
        )
      : await runMutation(
          "submit",
          () => updateQueueTask(editor.taskId, {
            folder: cleanFolder,
            title: trimmedTitle,
            prompt,
            agent,
            hold,
          }),
          (msg) => setFormError(msg || null),
        );
    if (ok) {
      setEditor(null);
      setBrowsing(false);
      setFormError(null);
    }
  };

  const saveSettings = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (watching) return;
    const parsed = parseQueueSettingsDraft(settingsDraft);
    if (!parsed) {
      setSettingsError(t("Enter non-negative numbers for memory and cooldown, and at least 1 for max working agents."));
      return;
    }
    setSettingsError(null);
    const ok = await runMutation("settings", () => updateQueueSettings(parsed));
    if (ok) setSettingsOpen(false);
  };

  const toggleSettings = (): void => {
    if (!settingsOpen && snapshot) {
      setSettingsDraft({
        minMemMb: String(snapshot.settings.minMemMb),
        maxWorking: String(snapshot.settings.maxWorking),
        cooldownSec: String(snapshot.settings.cooldownSec),
      });
      setSettingsError(null);
    }
    setSettingsOpen((shown) => !shown);
  };

  const togglePromptExpanded = (id: string): void => {
    setExpandedPrompts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const closeFromScrim = (event: MouseEvent<HTMLDivElement>): void => {
    if (!busy && event.target === event.currentTarget) onClose();
  };

  const gate = snapshot?.gate ?? null;
  const settings = snapshot?.settings ?? DEFAULT_QUEUE_SETTINGS;
  const groups = groupQueueTasksByFolder(snapshot?.tasks ?? []);
  const waiting = gate !== null && isQueueGateWaiting(gate.status);
  const pickerAgents = mergeAgentsWithSelected(agents, agent);

  const taskStatusLabel = (task: QueueTask): string => {
    switch (task.status) {
      case "running": return task.needsInput ? t("Needs you") : t("Running|queue");
      case "done": return t("Done");
      case "failed": return t("Failed");
      case "queued": return task.hold ? t("On hold") : t("Queued");
    }
  };

  return (
    <div className="modal-scrim queue-scrim" onMouseDown={closeFromScrim}>
      <div
        ref={surface}
        className="modal queue-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="modal-header queue-header">
          {editor !== null && (
            <button
              type="button"
              className="icon-button queue-back-button"
              aria-label={t("Back")}
              title={t("Back")}
              disabled={busy}
              onClick={closeEditor}
            >
              <ChevronLeft aria-hidden="true" />
            </button>
          )}
          <h2 className="modal-title" id={titleId}>
            {editor === null
              ? t("Agent Queue")
              : editor.mode === "create"
                ? t("Add queued task")
                : t("Edit queued task")}
          </h2>
          {editor === null && (
            <div className="queue-header-actions">
              <button
                type="button"
                className="icon-button"
                aria-label={t("Refresh")}
                title={t("Refresh")}
                disabled={loading || busy}
                onClick={() => void refreshNow()}
              >
                <RefreshCw className={loading ? "is-spinning" : undefined} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={`icon-button${settingsOpen ? " is-active" : ""}`}
                aria-label={t("Queue settings")}
                title={t("Queue settings")}
                aria-expanded={settingsOpen}
                disabled={busy}
                onClick={toggleSettings}
              >
                <SlidersHorizontal aria-hidden="true" />
              </button>
              {!watching && (
                <button
                  type="button"
                  className={`btn queue-pause-btn${settings.paused ? " is-paused" : ""}`}
                  aria-pressed={settings.paused}
                  disabled={busy || !snapshot}
                  onClick={() => void runMutation("pause", () => updateQueueSettings({ paused: !settings.paused }))}
                >
                  {settings.paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
                  <span>{settings.paused ? t("Resume|queue") : t("Pause|queue")}</span>
                </button>
              )}
              {!watching && (
                <button
                  type="button"
                  className="btn btn-primary queue-add-btn"
                  disabled={busy}
                  onClick={() => openCreateForm()}
                >
                  <Plus aria-hidden="true" />
                  <span>{t("Add task")}</span>
                </button>
              )}
            </div>
          )}
          <button
            ref={closeButtonRef}
            type="button"
            className="icon-button"
            aria-label={t("Close agent queue")}
            title={t("Close agent queue")}
            disabled={busy}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>

        {editor !== null ? (
          <form className="queue-editor-form" onSubmit={(event) => void submitTask(event)}>
            <div className="modal-body queue-editor">
              <div className="field">
                <label className="field-label" htmlFor="queue-task-folder">{t("Project folder")}</label>
                <div className="queue-folder-row">
                  <input
                    ref={folderInputRef}
                    id="queue-task-folder"
                    className="input"
                    value={folder}
                    placeholder="~/projects/app"
                    disabled={busy}
                    autoComplete="off"
                    aria-describedby={folderHintId}
                    onChange={(event) => {
                      setFolder(event.target.value);
                      setFormError(null);
                    }}
                    onBlur={showFolderEnd}
                  />
                  <button
                    type="button"
                    className="btn"
                    aria-expanded={browsing}
                    disabled={busy}
                    onClick={() => setBrowsing((shown) => !shown)}
                  >
                    <FolderOpen aria-hidden="true" />
                    <span>{t("Browse")}</span>
                  </button>
                </div>
                {browsing && (
                  <DirectoryBrowser
                    start={folder}
                    onPick={(picked) => {
                      setFolder(picked);
                      setFormError(null);
                      setBrowsing(false);
                    }}
                    onFolder={(path, home) => {
                      setFolder(homeRelative(path, home));
                      setFormError(null);
                    }}
                  />
                )}
                <span id={folderHintId} className="field-hint">{t("Select project folder or type ~/…")}</span>
              </div>

              {recentFolders.length > 0 && (
                <div className="field queue-recents">
                  <span className="field-label" id={recentsId}>{t("Recent folders")}</span>
                  <RecentFolderChips
                    folders={recentFolders}
                    disabled={busy}
                    labelledBy={recentsId}
                    basename={queueFolderName}
                    onPick={(picked) => {
                      setFolder(picked);
                      setFormError(null);
                      setBrowsing(false);
                    }}
                  />
                </div>
              )}

              <div className="queue-editor-split">
                <div className="field">
                  <span className="field-label" id={agentLabelId}>{t("Agent")}</span>
                  <AgentPicker
                    agents={pickerAgents}
                    value={agent}
                    shell={false}
                    disabled={busy}
                    labelledBy={agentLabelId}
                    onChange={setAgent}
                  />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor={titleLabelId}>{t("Task title")}</label>
                  <input
                    id={titleLabelId}
                    className="input"
                    value={taskTitle}
                    disabled={busy}
                    autoComplete="off"
                    placeholder={prompt.trim() ? queueTaskTitleFallback(prompt) : t("Optional|queue")}
                    onChange={(event) => setTaskTitle(event.target.value)}
                  />
                </div>
              </div>

              <div className="field">
                <label className="field-label" htmlFor={promptLabelId}>{t("Prompt|queue")}</label>
                <textarea
                  ref={promptInputRef}
                  id={promptLabelId}
                  className="input queue-prompt-input"
                  rows={5}
                  value={prompt}
                  disabled={busy}
                  enterKeyHint="enter"
                  aria-describedby={promptHintId}
                  onChange={(event) => {
                    setPrompt(event.target.value);
                    setFormError(null);
                  }}
                />
                <span id={promptHintId} className="field-hint">
                  {t("Multi-line instructions sent to the agent when its turn starts")}
                </span>
              </div>

              <div className="queue-hold-row">
                <Toggle
                  id="queue-task-hold"
                  checked={hold}
                  label={t("Hold")}
                  disabled={busy}
                  onChange={setHold}
                />
                <div className="queue-hold-copy">
                  <label className="queue-hold-label" htmlFor="queue-task-hold">{t("Hold")}</label>
                  <span className="field-hint">{t("Skip automatic launches until you release it")}</span>
                </div>
              </div>

              {formError && <p className="queue-error" role="alert">{formError}</p>}
            </div>

            <footer className="modal-footer">
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={closeEditor}>
                {t("Cancel")}
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busyKey === "submit"
                  ? t(editor.mode === "create" ? "Adding…" : "Saving…|queue")
                  : t(editor.mode === "create" ? "Add task" : "Save")}
              </button>
            </footer>
          </form>
        ) : (
          <div className="modal-body queue-body">
            {watching && (
              <p className="queue-notice" role="status">
                {t("View only: queue changes are disabled on this device.")}
              </p>
            )}

            {error && (
              <div className="queue-error-banner" role="alert">
                <span>{error}</span>
                <button type="button" className="btn btn-ghost" onClick={() => setError(null)}>
                  {t("Dismiss")}
                </button>
              </div>
            )}

            {gate !== null && (
              <section className={`queue-gate${settings.paused ? " is-paused" : waiting ? " is-waiting" : gate.status === "ready" ? " is-ready" : ""}`} aria-live="polite">
                <div className="queue-gate-main">
                  <span className="queue-gate-dot" aria-hidden="true" />
                  <span className="queue-gate-summary">{describeQueueGate(gate, settings, t)}</span>
                </div>
                <div className="queue-gate-pills">
                  {gate.memAvailableMb !== null && (
                    <span className="pill">
                      {t("Free RAM {free} (min {min})", {
                        free: formatQueueGb(gate.memAvailableMb),
                        min: formatQueueGb(settings.minMemMb),
                      })}
                    </span>
                  )}
                  <span className="pill">
                    {t("Working {working}/{max}", {
                      working: gate.workingCount,
                      max: settings.maxWorking,
                    })}
                  </span>
                  {gate.cooldownLeftSec > 0 && (
                    <span className="pill">
                      {t("Cooldown {remaining}", {
                        remaining: formatQueueDuration(gate.cooldownLeftSec),
                      })}
                    </span>
                  )}
                </div>
              </section>
            )}

            {settingsOpen && (
              <form className="queue-settings-panel" onSubmit={(event) => void saveSettings(event)}>
                <div className="queue-settings-grid">
                  <div className="field">
                    <label className="field-label" htmlFor={minMemId}>{t("Min free memory (MB)")}</label>
                    <input
                      id={minMemId}
                      className="input"
                      type="number"
                      min={0}
                      step={128}
                      inputMode="numeric"
                      value={settingsDraft.minMemMb}
                      disabled={watching || busy}
                      onChange={(event) => setSettingsDraft((d) => ({ ...d, minMemMb: event.target.value }))}
                    />
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor={maxWorkingId}>{t("Max working agents")}</label>
                    <input
                      id={maxWorkingId}
                      className="input"
                      type="number"
                      min={1}
                      step={1}
                      inputMode="numeric"
                      value={settingsDraft.maxWorking}
                      disabled={watching || busy}
                      onChange={(event) => setSettingsDraft((d) => ({ ...d, maxWorking: event.target.value }))}
                    />
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor={cooldownId}>{t("Cooldown (seconds)")}</label>
                    <input
                      id={cooldownId}
                      className="input"
                      type="number"
                      min={0}
                      step={15}
                      inputMode="numeric"
                      value={settingsDraft.cooldownSec}
                      disabled={watching || busy}
                      onChange={(event) => setSettingsDraft((d) => ({ ...d, cooldownSec: event.target.value }))}
                    />
                  </div>
                </div>
                {settingsError && <p className="queue-error" role="alert">{settingsError}</p>}
                <div className="queue-settings-actions">
                  <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setSettingsOpen(false)}>
                    {t("Cancel")}
                  </button>
                  {!watching && (
                    <button type="submit" className="btn btn-primary" disabled={busy}>
                      {busyKey === "settings" ? t("Saving…|queue") : t("Save settings")}
                    </button>
                  )}
                </div>
              </form>
            )}

            {snapshot === null && loading ? (
              <p className="queue-empty-note" role="status">{t("Loading…")}</p>
            ) : groups.length === 0 ? (
              <div className="queue-empty">
                <p className="queue-empty-title">{t("No queued tasks yet")}</p>
                <p className="queue-empty-note">
                  {t("Queue work by project folder. When memory, active agent limits and cooldown allow, the next task starts automatically in a tab.")}
                </p>
                {!watching && (
                  <button type="button" className="btn btn-primary" onClick={() => openCreateForm()}>
                    <Plus aria-hidden="true" />
                    <span>{t("Add task")}</span>
                  </button>
                )}
              </div>
            ) : (
              <div className="queue-groups">
                {groups.map((group) => (
                  <section key={group.folder} className="queue-project-card">
                    <header className="queue-project-header">
                      <div className="queue-project-title">
                        <FolderOpen aria-hidden="true" />
                        <span className="queue-project-name">{group.name}</span>
                        <span className="queue-project-path" title={group.folder}><span dir="ltr">{group.folder}</span></span>
                      </div>
                      {!watching && (
                        <button
                          type="button"
                          className="btn queue-project-add"
                          aria-label={t("Add queued task to {folder}", { folder: group.name })}
                          title={t("Add queued task to {folder}", { folder: group.name })}
                          disabled={busy}
                          onClick={() => openCreateForm(group.folder)}
                        >
                          <Plus aria-hidden="true" />
                          <span>{t("Add task")}</span>
                        </button>
                      )}
                    </header>

                    <ul className="queue-task-list">
                      {group.tasks.map((task, index) => {
                        const isExpanded = expandedPrompts.has(task.id);
                        const hasLongPrompt = task.prompt.length > 140 || task.prompt.split(/\r?\n/).length > 3;
                        const canStart = task.status === "queued" && !watching && !busy && group.runningTask === null;
                        const isFirst = index === 0;
                        const isLast = index === group.tasks.length - 1;

                        return (
                          <li key={task.id} className={`queue-task-row is-${task.status}${task.needsInput ? " is-needs-input" : ""}${task.hold ? " is-hold" : ""}`}>
                            <div className="queue-task-top">
                              <span className={statusBadgeClass(task)}>{taskStatusLabel(task)}</span>
                              <span className="queue-task-agent" title={agentName(task.agent)}>
                                <AgentMark agent={task.agent} size={15} />
                                <span>{agentName(task.agent)}</span>
                              </span>
                              <strong className="queue-task-title">{task.title || queueTaskTitleFallback(task.prompt)}</strong>
                            </div>

                            <p className={`queue-task-prompt${isExpanded ? " is-expanded" : ""}`}>{task.prompt}</p>
                            {hasLongPrompt && (
                              <button
                                type="button"
                                className="queue-prompt-toggle"
                                onClick={() => togglePromptExpanded(task.id)}
                              >
                                {isExpanded ? t("Hide full prompt") : t("Show full prompt")}
                              </button>
                            )}

                            {task.error && <p className="queue-task-error" role="status">{task.error}</p>}

                            <div className="queue-task-actions">
                              {task.terminal && (
                                <button
                                  type="button"
                                  className="btn queue-open-tab"
                                  disabled={busy}
                                  onClick={() => onOpenPane(task.terminal!)}
                                >
                                  <ExternalLink aria-hidden="true" />
                                  <span>{t("Open tab")}</span>
                                </button>
                              )}

                              {!watching && task.status === "queued" && (
                                <>
                                  <button
                                    type="button"
                                    className="btn"
                                    disabled={!canStart}
                                    title={group.runningTask !== null ? t("Another task is already running in this project") : t("Start now")}
                                    onClick={() => void runMutation(`start:${task.id}`, () => startQueueTask(task.id))}
                                  >
                                    <Play aria-hidden="true" />
                                    <span>{t("Start now")}</span>
                                  </button>
                                  <button
                                    type="button"
                                    className="btn"
                                    disabled={busy}
                                    onClick={() => void runMutation(`hold:${task.id}`, () => updateQueueTask(task.id, { hold: !task.hold }))}
                                  >
                                    {task.hold ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
                                    <span>{task.hold ? t("Unhold") : t("Hold")}</span>
                                  </button>
                                  <button
                                    type="button"
                                    className="icon-button"
                                    aria-label={t("Move up")}
                                    title={t("Move up")}
                                    disabled={busy || isFirst}
                                    onClick={() => void runMutation(`up:${task.id}`, () => reorderQueueTasks({ id: task.id, direction: "up" }))}
                                  >
                                    <ArrowUp aria-hidden="true" />
                                  </button>
                                  <button
                                    type="button"
                                    className="icon-button"
                                    aria-label={t("Move down")}
                                    title={t("Move down")}
                                    disabled={busy || isLast}
                                    onClick={() => void runMutation(`down:${task.id}`, () => reorderQueueTasks({ id: task.id, direction: "down" }))}
                                  >
                                    <ArrowDown aria-hidden="true" />
                                  </button>
                                </>
                              )}

                              {!watching && (task.status === "done" || task.status === "failed") && (
                                <button
                                  type="button"
                                  className="btn"
                                  disabled={busy}
                                  onClick={() => void runMutation(`requeue:${task.id}`, () => updateQueueTask(task.id, { status: "queued" }))}
                                >
                                  <RotateCcw aria-hidden="true" />
                                  <span>{t("Requeue")}</span>
                                </button>
                              )}

                              {!watching && task.status !== "running" && (
                                <>
                                  <button
                                    type="button"
                                    className="icon-button"
                                    aria-label={t("Edit|queue")}
                                    title={t("Edit|queue")}
                                    disabled={busy}
                                    onClick={() => openEditForm(task)}
                                  >
                                    <Pencil aria-hidden="true" />
                                  </button>
                                  <button
                                    type="button"
                                    className="icon-button queue-delete-btn"
                                    aria-label={t("Delete")}
                                    title={t("Delete")}
                                    disabled={busy}
                                    onClick={() => void runMutation(`delete:${task.id}`, () => deleteQueueTask(task.id))}
                                  >
                                    <Trash2 aria-hidden="true" />
                                  </button>
                                </>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
