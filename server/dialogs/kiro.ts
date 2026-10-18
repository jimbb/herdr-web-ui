import type { DialogReader } from "./registry.ts";
import { ANSI_RE, SELECTED_RE, type MenuRow, type ParsedPrompt, cleanLine, findLastIndex, finishPrompt, isDivider, normalizeText, wrapped } from "./shared.ts";

export const KIRO_APPROVAL_HINT_RE = /↑↓\s*to navigate\b.*↵\s*to select|to navigate.*to select/i;
const KIRO_APPROVAL_HEADER_RE = /\brequires approval\s*$/i;

/** Kiro 2.32's approval rows are selected with arrows and Enter, never digit keys. */
function parseKiroApproval(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => KIRO_APPROVAL_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  const headerIndex = findLastIndex(lines.slice(0, hintIndex), (line) => KIRO_APPROVAL_HEADER_RE.test(cleanLine(line)));
  if (headerIndex < 0) return null;
  const rows: MenuRow[] = [];
  for (let index = headerIndex + 1; index < hintIndex; index += 1) {
    const text = cleanLine(lines[index]!);
    if (!text || isDivider(lines[index]!)) continue;
    // The "shell → command" detail belongs in the body, not among the choices.
    if (/→|\u2192/.test(text)) continue;
    const selected = SELECTED_RE.test(text);
    const label = normalizeText(text.replace(SELECTED_RE, ""));
    if (!label || label.length > 40) continue;
    rows.push({ label, selected, checked: false, lineIndex: index });
  }
  if (rows.length < 2 || rows.filter((row) => row.selected).length !== 1) return null;
  const header = cleanLine(lines[headerIndex]!);
  const detail = lines.slice(headerIndex + 1, rows[0]!.lineIndex).map(cleanLine).filter((line) => line && !isDivider(line)).join("\n");
  return finishPrompt("kiro", {
    kind: "approval", title: header, question: header,
    body: detail || null,
    options: rows.map((row) => ({ label: row.label, description: null })), multi_select: false, custom_option_index: null,
  }, {
    responder: "kiro-approval", menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected), checkedOptionIndices: [], customMenuIndex: null,
    rejectWithEscapeIndex: null,
  });
}

export const readers: readonly DialogReader[] = [{
  id: "kiro-approval", agents: ["kiro"], priority: 10,
  reread: "none", list: "none", parse: parseKiroApproval,
}];
