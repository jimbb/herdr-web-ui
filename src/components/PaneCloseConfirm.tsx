import { useT } from "../lib/i18n.ts";
import type { ClosingPane } from "../lib/paneClose.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

interface Props {
  closing: ClosingPane | null;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

export function PaneCloseConfirm({ closing, onClose, onConfirm }: Props) {
  const t = useT();
  if (!closing) return null;
  return (
    <ConfirmDialog
      title={t("Close pane {name}?", { name: closing.label })}
      body={t("The pane's running processes will stop. Closing its last pane also closes the workspace.")}
      confirmLabel={t("Close pane")}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
}
