/**
 * Shared pane-close rules (#237, #3286): closing the last pane in a workspace or an active
 * agent (`working` / `blocked`) asks for confirmation first, while an in-flight close per
 * `(machineId, workspaceId)` waits for herdr's roster update before accepting another close in
 * the same workspace.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { HerdrPane } from "../../shared/protocol.ts";

export interface ClosingPane {
  machineId: string;
  pane: HerdrPane;
  label: string;
}

export interface ClosePaneRequest {
  machineId: string;
  pane: HerdrPane;
  /** Panes of that machine's snapshot so matching workspace IDs on different PCs stay separate. */
  panes: readonly HerdrPane[] | undefined;
  label: string;
}

export function paneCloseNeedsConfirm(pane: HerdrPane, panes: readonly HerdrPane[] | undefined): boolean {
  const inWorkspace = panes?.filter((item) => item.workspace_id === pane.workspace_id).length ?? 1;
  return inWorkspace === 1 || pane.agent_status === "working" || pane.agent_status === "blocked";
}

interface UsePaneCloseOptions {
  closePane: (paneId: string, machineId: string) => Promise<void>;
  /** Changes when the underlying snapshot or machine list updates, to prune completed closes. */
  roster: unknown;
  isLive: (machineId: string, paneId: string) => boolean;
  isLocked?: (machineId: string, paneId: string) => boolean;
  watching?: boolean;
  /** Clears an open confirmation when the enclosing view moves on (such as switching tabs). */
  resetKey?: unknown;
  onBeforeImmediate?: (machineId: string, paneId: string) => void;
  onSuccess?: (machineId: string, paneId: string) => void;
  onError?: (reason: unknown, machineId: string, paneId: string) => void;
}

export function usePaneClose({
  closePane,
  roster,
  isLive,
  isLocked,
  watching = false,
  resetKey = null,
  onBeforeImmediate,
  onSuccess,
  onError,
}: UsePaneCloseOptions) {
  const [closing, setClosing] = useState<ClosingPane | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const latest = useRef({ closePane, isLive, isLocked, onBeforeImmediate, onSuccess, onError });
  latest.current = { closePane, isLive, isLocked, onBeforeImmediate, onSuccess, onError };

  // Keep at most one unacknowledged close per (machine, workspace) until herdr drops the pane
  // from the roster, so a fast second close cannot miss the "last pane" check (#3286).
  const closingIn = useRef(new Map<string, { machineId: string; paneId: string }>());
  useEffect(() => {
    for (const [scope, entry] of closingIn.current) {
      if (!latest.current.isLive(entry.machineId, entry.paneId)) closingIn.current.delete(scope);
    }
  }, [roster]);

  useEffect(() => { setClosing(null); }, [resetKey]);

  const activeClosing = closing
    && !watching
    && !isLocked?.(closing.machineId, closing.pane.pane_id)
    && isLive(closing.machineId, closing.pane.pane_id)
    ? closing
    : null;

  useEffect(() => {
    if (closing !== null && activeClosing === null) setClosing(null);
  }, [closing, activeClosing]);

  const executeClose = useCallback(async (target: ClosingPane): Promise<void> => {
    const scope = JSON.stringify([target.machineId, target.pane.workspace_id]);
    closingIn.current.set(scope, { machineId: target.machineId, paneId: target.pane.pane_id });
    try {
      await latest.current.closePane(target.pane.pane_id, target.machineId);
    } catch (reason) {
      const current = closingIn.current.get(scope);
      if (current?.machineId === target.machineId && current.paneId === target.pane.pane_id) closingIn.current.delete(scope);
      throw reason;
    }
  }, []);

  const requestClose = useCallback((request: ClosePaneRequest): void => {
    const scope = JSON.stringify([request.machineId, request.pane.workspace_id]);
    if (closingIn.current.has(scope) || watching || latest.current.isLocked?.(request.machineId, request.pane.pane_id)) return;
    const target: ClosingPane = { machineId: request.machineId, pane: request.pane, label: request.label };
    if (paneCloseNeedsConfirm(request.pane, request.panes)) {
      setClosing(target);
      return;
    }
    latest.current.onBeforeImmediate?.(request.machineId, request.pane.pane_id);
    void executeClose(target).then(
      () => { if (alive.current) latest.current.onSuccess?.(request.machineId, request.pane.pane_id); },
      (reason: unknown) => { if (alive.current) latest.current.onError?.(reason, request.machineId, request.pane.pane_id); },
    );
  }, [executeClose, watching]);

  const clearClosing = useCallback(() => setClosing(null), []);

  const confirmClosing = useCallback(async (): Promise<void> => {
    const target = activeClosing;
    if (!target) return;
    await executeClose(target);
    if (!alive.current) return;
    setClosing(null);
    latest.current.onSuccess?.(target.machineId, target.pane.pane_id);
  }, [activeClosing, executeClose]);

  return { closing: activeClosing, clearClosing, requestClose, confirmClosing };
}
