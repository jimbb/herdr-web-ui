import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import type { RowMenuItem } from "../components/RowMenu.tsx";
import { closePane as closeMachinePane, routeMissing } from "./api.ts";
import { useT } from "./i18n.ts";
import { usePaneClose, type ClosingPane } from "./paneClose.ts";
import { usePaneLockChecker } from "./paneLocks.ts";
import { sidebarPinKey } from "./sidebarPins.ts";
import { userErrorMessage, type UserError } from "./userError.ts";

export interface ThreadCloseEligibility {
  inMode: boolean;
  inboxShown: boolean;
  guideShown: boolean;
  watching: boolean;
  machineConnected: boolean;
  paneLocked: boolean;
  hasPane: boolean;
}

export function canCloseInboxThread(state: ThreadCloseEligibility): boolean {
  return state.inMode
    && !state.inboxShown
    && !state.guideShown
    && !state.watching
    && state.hasPane
    && state.machineConnected
    && !state.paneLocked;
}

export function buildModeThreadItems(
  baseItems: readonly RowMenuItem[],
  close: { label: string; run: () => void; disabled?: boolean } | null,
): RowMenuItem[] {
  const items = baseItems.map((item) => ({ ...item, divider: false }));
  if (close === null) return items;
  // greyed, not gone, while the machine reconnects: a phone's menu keeps its shape through a dropped socket
  return [...items, { id: "close", label: close.label, icon: X, danger: true, divider: true, disabled: close.disabled === true, run: close.run }];
}

export interface ModeMoreSections {
  palette: readonly RowMenuItem[];
  lead: readonly RowMenuItem[];
  thread: readonly RowMenuItem[];
  end: readonly RowMenuItem[];
  app: readonly RowMenuItem[];
}

export function buildModeMoreItems(
  layout: { inboxWide: boolean; inboxShown: boolean; hasPane: boolean },
  sections: ModeMoreSections,
): RowMenuItem[] {
  const paletteOnly = layout.inboxWide && (layout.inboxShown || !layout.hasPane);
  if (paletteOnly) return [...sections.palette];
  if (layout.inboxShown) return [...sections.app];
  const thread = sections.thread.map((item, index) => (index === 0 ? { ...item, divider: true } : item));
  if (layout.inboxWide) return [...sections.palette, ...thread];
  const end = sections.end.map((item, index) => ({ ...item, divider: index === 0 }));
  return [...sections.lead, ...thread, ...end];
}

export interface UseInboxThreadCloseOptions {
  machines: readonly Machine[];
  inMode: boolean;
  inboxShown: boolean;
  guideShown: boolean;
  watching: boolean;
  selectedMachineId: string;
  selectedMachine: Machine | undefined;
  selectedPane: HerdrPane | null;
  labelFor: (machineId: string, pane: HerdrPane) => string;
  onClosed: (machineId: string, paneId: string) => void;
  closePane?: (paneId: string, machineId: string) => Promise<void>;
}

export interface InboxThreadCloseController {
  offered: boolean;
  /** offered but for the connection: the menu lists Close (disabled) while the machine reconnects */
  listed: boolean;
  closing: ClosingPane | null;
  error: UserError | null;
  clearError: () => void;
  clearClosing: () => void;
  confirmClosing: () => Promise<void>;
  request: () => void;
  suppressedReturnRow: (returnTo: string | null) => string | null;
}

export function useInboxThreadClose({
  machines,
  inMode,
  inboxShown,
  guideShown,
  watching,
  selectedMachineId,
  selectedMachine,
  selectedPane,
  labelFor,
  onClosed,
  closePane = closeMachinePane,
}: UseInboxThreadCloseOptions): InboxThreadCloseController {
  const t = useT();
  const paneLocked = usePaneLockChecker();
  const [error, setError] = useState<UserError | null>(null);
  const closedKeyRef = useRef<string | null>(null);

  const eligibility = {
    inMode,
    inboxShown,
    guideShown,
    watching,
    machineConnected: selectedMachine?.state === "connected",
    paneLocked: selectedPane !== null && paneLocked(selectedMachineId, selectedPane.pane_id),
    hasPane: selectedPane !== null,
  };
  const offered = canCloseInboxThread(eligibility);
  const listed = canCloseInboxThread({ ...eligibility, machineConnected: true });

  const threadKey = inMode && !inboxShown && selectedPane !== null
    ? sidebarPinKey(selectedMachineId, selectedPane.pane_id)
    : null;

  useEffect(() => {
    setError(null);
  }, [threadKey]);

  useEffect(() => {
    if (!inMode || !inboxShown) closedKeyRef.current = null;
  }, [inMode, inboxShown]);

  const latest = useRef({
    machines,
    offered,
    selectedMachineId,
    selectedMachine,
    selectedPane,
    labelFor,
    onClosed,
    t,
  });
  latest.current = {
    machines,
    offered,
    selectedMachineId,
    selectedMachine,
    selectedPane,
    labelFor,
    onClosed,
    t,
  };

  const { closing, clearClosing, requestClose, confirmClosing } = usePaneClose({
    closePane,
    roster: machines,
    isLive: (machineId, paneId) => {
      const machine = latest.current.machines.find((candidate) => candidate.id === machineId);
      return machine?.state === "connected" && machine.snapshot?.panes.some((pane) => pane.pane_id === paneId) === true;
    },
    isLocked: paneLocked,
    watching,
    resetKey: offered ? threadKey : null,
    onBeforeImmediate: () => setError(null),
    onSuccess: (machineId, paneId) => {
      closedKeyRef.current = sidebarPinKey(machineId, paneId);
      latest.current.onClosed(machineId, paneId);
    },
    onError: (reason) => {
      if (routeMissing(reason)) {
        setError({ message: latest.current.t("This PC's bridge does not offer this yet"), detail: null });
        return;
      }
      const err = userErrorMessage(reason);
      setError({ message: latest.current.t("Close failed: {reason}", { reason: err.message }), detail: err.detail });
    },
  });

  const clearError = useCallback(() => setError(null), []);

  const request = useCallback((): void => {
    const current = latest.current;
    if (!current.offered || current.selectedPane === null) return;
    setError(null);
    requestClose({
      machineId: current.selectedMachineId,
      pane: current.selectedPane,
      panes: current.selectedMachine?.snapshot?.panes,
      label: current.labelFor(current.selectedMachineId, current.selectedPane),
    });
  }, [requestClose]);

  const suppressedReturnRow = useCallback((returnTo: string | null): string | null => (
    returnTo !== null && returnTo === closedKeyRef.current ? null : returnTo
  ), []);

  return {
    offered,
    listed,
    closing,
    error,
    clearError,
    clearClosing,
    confirmClosing,
    request,
    suppressedReturnRow,
  };
}
