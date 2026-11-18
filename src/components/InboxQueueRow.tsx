import { Ellipsis, ListOrdered, Pause, Play, Trash2 } from "lucide-react";
import { useState, type RefObject } from "react";
import { queueFolderName, queueTaskTitleFallback, type QueueSnapshot } from "../../shared/agent-queue.ts";
import type { InboxQueueEntry } from "../lib/agentInbox.ts";
import { inboxQueueState } from "../lib/agentQueue.ts";
import { deleteQueueTask, startQueueTask, updateQueueTask } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { RowMenu } from "./RowMenu.tsx";

export function InboxQueueRow({ entry, popup, watching, busy, onOpen, onAction, list }: {
  entry: InboxQueueEntry;
  popup: "dialog" | "menu";
  watching: boolean;
  busy: boolean;
  onOpen(id: string): void;
  onAction(mutation: () => Promise<QueueSnapshot>, restoreFocus?: () => void): void;
  list: RefObject<HTMLElement | null>;
}) {
  const t = useT();
  const [menu, setMenu] = useState<HTMLButtonElement | null>(null);
  const { task, position, canStart } = entry;
  const title = task.title || queueTaskTitleFallback(task.prompt);
  const state = inboxQueueState(t, task);
  const words = [queueFolderName(task.folder), position === null ? state : `${state} #${position}`].join(" · ");
  const run = (mutation: () => Promise<QueueSnapshot>, removesRow = false) => () => {
    const anchor = menu;
    onAction(mutation, removesRow ? () => {
      if (document.activeElement === document.body || document.activeElement === anchor) list.current?.focus({ preventScroll: true });
    } : undefined);
  };
  return (
    <li className="inbox-item" data-queue-task={task.id} data-state="queued">
      <button type="button" className="inbox-row" aria-haspopup="dialog" aria-label={`${title}, ${words}`} title={`${title}\n${words}`} onClick={() => onOpen(task.id)}>
        <span className="inbox-avatar" aria-hidden="true"><span className="inbox-avatar-face"><ListOrdered /></span></span>
        <span className="inbox-body">
          <span className="inbox-line"><span className="inbox-name" dir="auto">{title}</span></span>
          <span className="inbox-words" dir="auto">{words}</span>
        </span>
      </button>
      {!watching && <button type="button" className="icon-button inbox-close inbox-queue-menu" aria-label={t("Actions for {task}", { task: title })}
        aria-haspopup={popup} aria-expanded={menu !== null} onClick={(event) => setMenu(menu ? null : event.currentTarget)}><Ellipsis aria-hidden="true" /></button>}
      {menu !== null && !watching && <RowMenu anchor={menu} title={title} onClose={() => setMenu(null)} items={[
        ...(task.status !== "queued" ? [] : [
          { id: "start", label: t("Start now"), icon: Play, disabled: busy || !canStart, run: run(() => startQueueTask(task.id), true) },
          { id: "hold", label: task.hold ? t("Unhold") : t("Hold"), icon: task.hold ? Play : Pause, disabled: busy, run: run(() => updateQueueTask(task.id, { hold: !task.hold })) },
        ]),
        { id: "remove", label: t("Remove"), icon: Trash2, danger: true, disabled: busy, run: run(() => deleteQueueTask(task.id), true) },
      ]} />}
    </li>
  );
}
