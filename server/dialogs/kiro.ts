import type { DialogReader } from "./registry.ts";
import { ANSI_RE, type MenuRow, type ParsedPrompt, cleanLine, finishPrompt, isDivider } from "./shared.ts";

// Kiro 2.32's footer, whole: a looser match would keep a card live on any text naming those keys
export const KIRO_APPROVAL_HINT_RE = /^esc to close\s*·\s*↑↓\s*to navigate\s*·\s*↵\s*to select(?:\s*·\s*tab to edit)?$/i;
const KIRO_APPROVAL_HEADER_RE = /\brequires approval\s*$/i;
const KIRO_DETAIL_RE = /^\S+\s*→/;
// only the choices Kiro draws: a command's own lines must never read as one
const KIRO_APPROVAL_ROW_RE = /^([❯›>])?\s*(Allow|Always allow|Deny|Always deny)$/;

/** The footer's first line, tried on one line or wrapped over up to three. */
function hintStart(lines: string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    for (let span = 1; span <= 3; span += 1) {
      const text = lines.slice(index, index + span).map(cleanLine).filter(Boolean).join(" ");
      if (KIRO_APPROVAL_HINT_RE.test(text)) return index;
    }
  }
  return -1;
}

/**
 * Kiro 2.32's approval: a "<what> requires approval" header, its detail ("shell → <command>"), the
 * rows right above the footer, selected with arrows and Enter, never digit keys. Every line between
 * the header and the rows is the body, so the card shows the whole command.
 */
function parseKiroApproval(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = hintStart(lines);
  if (hintIndex < 0) return null;
  let index = hintIndex - 1;
  while (index >= 0 && (!cleanLine(lines[index]!) || isDivider(lines[index]!))) index -= 1;
  const rows: MenuRow[] = [];
  for (; index >= 0; index -= 1) {
    const match = KIRO_APPROVAL_ROW_RE.exec(cleanLine(lines[index]!));
    if (!match) break;
    rows.unshift({ label: match[2]!, selected: Boolean(match[1]), checked: false, lineIndex: index });
  }
  const labels = rows.map((row) => row.label);
  if (rows.length < 2 || new Set(labels).size !== labels.length || rows.filter((row) => row.selected).length !== 1) return null;
  // the header is the line right over the tool's "<tool> → …" detail. The screen above is the agent's to
  // draw: a command that prints another such pair (or a footer) could pass for it and hide what is above,
  // so the whole screen must hold one, else no card
  const headers: number[] = [];
  for (let at = index; at >= 0; at -= 1) {
    if (KIRO_APPROVAL_HEADER_RE.test(cleanLine(lines[at]!)) && KIRO_DETAIL_RE.test(cleanLine(lines[at + 1] ?? ""))) headers.push(at);
  }
  if (headers.length !== 1) return null;
  const headerIndex = headers[0]!;
  const header = cleanLine(lines[headerIndex]!);
  const detail = lines.slice(headerIndex + 1, rows[0]!.lineIndex).filter((line) => !isDivider(line)).map(cleanLine)
    .join("\n").trim();
  return finishPrompt("kiro", {
    kind: "approval", title: header, question: header,
    body: detail || null,
    options: labels.map((label) => ({ label, description: null })), multi_select: false, custom_option_index: null,
  }, {
    responder: "kiro-approval", menuLabels: labels,
    selectedIndex: rows.findIndex((row) => row.selected), checkedOptionIndices: [], customMenuIndex: null,
    rejectWithEscapeIndex: null,
  });
}

export const readers: readonly DialogReader[] = [{
  id: "kiro-approval", agents: ["kiro"], priority: 10,
  reread: "none", list: "none", parse: parseKiroApproval,
}];
