import type { DialogReader } from "./registry.ts";
import { ANSI_RE, KEY, cleanLine, findLastIndex, finishPrompt, joinWrapped, keySteps, navigationKeys, own, screenWidth, type ParsedPrompt } from "./shared.ts";

/**
 * DeepSeek Harness's `ask_user_question` panel, as dsh-tui 0.20.0 draws it
 * (lib/types/components/questions/AskUserQuestionPanel.js):
 *
 *   ─────────▾  📋 Question 1/2  · 2 left  ─────────
 *
 *   ◈ Platforms
 *   Which platforms should we test?
 *
 *   ❯○ iOS
 *    ○ Android
 *       optional description, dim
 *    ✎ Custom answer： Type directly…
 *
 *   ↑/↓ select · Space multi-select · Ctrl+V paste · Type text to attach an answer · Enter
 *   submit · Esc cancel · ←/→ switch question · Ctrl+K to fold / click the header
 *
 * A row is `<cursor><mark> label` with the cursor `❯` or a space and the mark `●`/`○` (one
 * choice) or `◉`/`○` (several); a description, and a label the pane wraps, go on two columns
 * further in. The last row is always the free-text row (`✎`), which typing on any row fills.
 * ↑/↓ move, Space ticks a row of a multiple choice, Enter answers the question (and goes on to the
 * next one of the batch), ←/→ switch questions without answering, Esc cancels.
 *
 * dsh-tui speaks English or Chinese (DSH_TUI_LANG, else the OS locale): both hints are read.
 */
const DSH_HEADER_RE = /▾\s+📋\s*(?:Question\s+(\d+)\/(\d+)|提问\s*·\s*第\s*(\d+)\/(\d+)\s*题)/;
/** the option list's hint: its select key first, its cancel or previous-question key later */
const DSH_HINT_RE = /^(?:↑\/↓ select|↑\/↓ 选择)\b.*(?:Esc (?:cancel|previous question)|Esc (?:中断|上一题))/;
/** the free-text row's own hint, with the cursor on it */
const DSH_TYPING_HINT_RE = /^(?:Type answer|输入回答)\b.*(?:Esc (?:cancel|previous question)|Esc (?:中断|上一题))/;
const DSH_MULTI_RE = /\bSpace (?:multi-select|多选)\b/;
const DSH_SWITCH_RE = /←\/→ (?:switch question|换题)|行首←\/行尾→ 换题|←\/→ at the text edge switches question/;
/** rows, from the free-text row's column: dsh sets the panel in two columns past the chat's own margin */
const DSH_ROW_RE = /^( *)([❯ ])([●○◉])\s(.+)$/;
const DSH_CUSTOM_RE = /^( *)([❯ ])✎\s(?:Custom answer|自定义回答)/;
/** the free-text row with nothing in it: no text typed, no option's label attached (`(attached: …)`) */
const DSH_CUSTOM_EMPTY_RE = /^ *[❯ ]✎\s(?:Custom answer|自定义回答)：\s*(?:Type directly…|直接输入…)?$/;
const DSH_HINT_LINES = 4;

/** The hint with whatever a narrow pane wrapped onto the lines under it. */
function hintAt(lines: string[], index: number): string {
  return lines.slice(index, index + DSH_HINT_LINES).map(cleanLine).filter(Boolean).join(" ");
}

export function parseDshQuestion(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map((line) => line.trimEnd());
  const headerIndex = findLastIndex(lines, (line) => DSH_HEADER_RE.test(line));
  if (headerIndex < 0) return null;
  const header = DSH_HEADER_RE.exec(lines[headerIndex]!)!;
  const n = Number(header[1] ?? header[3]);
  const total = Number(header[2] ?? header[4]);
  if (!Number.isInteger(n) || !Number.isInteger(total) || n < 1 || total < n) return null;

  const customIndex = lines.findIndex((line, index) => index > headerIndex && DSH_CUSTOM_RE.test(line));
  if (customIndex < 0) return null;
  // the hint follows the free-text row (a multiple choice's Submit row may stand between them)
  const hintIndex = lines.findIndex((line, index) => index > customIndex && index <= customIndex + 4
    && (DSH_HINT_RE.test(hintAt(lines, index)) || DSH_TYPING_HINT_RE.test(hintAt(lines, index))));
  if (hintIndex < 0) return null;
  const hint = hintAt(lines, hintIndex);
  // text typed in the terminal (or an option's label it attached) would go out with any answer the
  // card sends: the terminal finishes what it began there
  if (!DSH_CUSTOM_EMPTY_RE.test(lines[customIndex]!)) return null;

  const custom = DSH_CUSTOM_RE.exec(lines[customIndex]!)!;
  const indent = custom[1]!;
  const customCursor = custom[2] === "❯";
  // the options: the run of rows right over the free-text row, each with its continuation lines
  // (a wrapped label or a description, set past the row's mark), read upwards from it
  const rows: { cursor: boolean; checked: boolean; head: string; rest: string[] }[] = [];
  let firstRow = -1;
  let rest: string[] = [];
  for (let index = customIndex - 1; index > headerIndex; index -= 1) {
    const line = lines[index]!;
    const row = DSH_ROW_RE.exec(line);
    if (row && row[1] === indent) {
      rows.unshift({ cursor: row[2] === "❯", checked: row[3] === "●" || row[3] === "◉", head: row[4]!.trim(), rest });
      rest = [];
      firstRow = index;
      continue;
    }
    // a focused row stands apart by one blank line (marginTop), which a continuation never does
    if (!line.trim()) continue;
    if (line.startsWith(`${indent}   `) && /\S/.test(line)) { rest.unshift(line); continue; }
    break;
  }
  if (rows.length === 0 || firstRow < 0 || rest.length > 0) return null;
  const cursors = rows.filter((row) => row.cursor).length + (customCursor ? 1 : 0);
  if (cursors !== 1) return null;
  // each row has its own hint: the option list's, or the free-text row's with the cursor on it
  if (customCursor !== DSH_TYPING_HINT_RE.test(hint)) return null;

  // the free-text row's hint names no Space: a multiple choice is told by its marks there
  const multi = DSH_MULTI_RE.test(hint) || rows.some((row) => row.checked && !row.cursor) || /◉/.test(lines.slice(firstRow, customIndex).join(""));
  // a single choice marks the cursor's row alone, and none while the cursor is on the free-text row
  if (!multi && rows.some((row) => row.checked !== row.cursor)) return null;

  // the header chip (`◈ Platforms`), the question, then a blank line and the question's detail; a
  // long question and detail fold into a window with a line saying how much of them is hidden
  const paragraphs: string[][] = [];
  let chip: string | null = null;
  let blank = true;
  for (const raw of lines.slice(headerIndex + 1, firstRow)) {
    const line = cleanLine(raw);
    if (!line) { blank = true; continue; }
    if (chip === null && paragraphs.length === 0 && line.startsWith("◈ ")) { chip = line.slice(2).trim(); continue; }
    if (/^…\s/.test(line)) break;
    if (blank) paragraphs.push([]);
    paragraphs.at(-1)!.push(raw);
    blank = false;
  }
  const width = screenWidth(lines);
  const question = joinWrapped(paragraphs[0] ?? [], width);
  if (!question) return null;
  const detail = paragraphs.slice(1).map((lines) => joinWrapped(lines, width)).filter(Boolean).join("\n");
  const body = [chip, detail].filter(Boolean).join("\n") || null;

  // Plain text cannot tell a label's wrapped rest from a description (only dsh's dim colour does):
  // what follows a row's first line is read as its description. The answer is the row's place,
  // never its words, so a misread split changes only how the card shows it.
  const options = rows.map((row) => {
    if (row.rest.length === 0) return { label: row.head, description: null };
    return { label: row.head, description: joinWrapped(row.rest, width) || null };
  });
  const selectedIndex = customCursor ? rows.length : rows.findIndex((row) => row.cursor);
  const checked = rows.flatMap((row, index) => multi && row.checked ? [index] : []);
  const at = n - 1;
  const switches = total > 1 && DSH_SWITCH_RE.test(hint);
  const back = switches && at > 0;
  const next = switches && at < total - 1;
  const title = total > 1 ? own("Question {n} of {total}", { n: String(n), total: String(total) }) : own("Question");

  return finishPrompt("dsh-tui", {
    kind: "question",
    title,
    question,
    body,
    options,
    multi_select: multi,
    custom_option_index: multi ? null : options.length,
    ...(checked.length > 0 ? { default_option_indices: checked } : {}),
    ...(back ? { can_step_back: true } : {}),
    ...(next ? { can_step_next: true } : {}),
  }, {
    ...(back || next ? { nativeSteps: { identity: `dsh:${total}`, index: at, count: total, next: KEY.right, previous: KEY.left } } : {}),
    responder: "dsh-question",
    menuLabels: [...options.map((option) => option.label), "Custom answer"],
    selectedIndex,
    checkedOptionIndices: checked,
    customMenuIndex: multi ? null : options.length,
    rejectWithEscapeIndex: null,
    // Enter on the free-text row with nothing typed only says to type first: the text goes in
    // once the cursor is there, then Enter sends it (measured on dsh-tui 0.20.0)
    customSteps: (text: string) => [
      ...keySteps(navigationKeys(options.length - selectedIndex)),
      { text: text.replace(/\s*\r?\n\s*/g, " ").trim() },
      ...keySteps([KEY.enter]),
    ],
    ...(multi ? {
      multiSteps: (picked: number[]) => {
        const want = new Set(picked);
        let cursor = selectedIndex;
        const keys: string[] = [];
        for (const index of options.keys()) {
          if (want.has(index) === checked.includes(index)) continue;
          keys.push(...navigationKeys(index - cursor), KEY.space);
          cursor = index;
        }
        // Enter on the free-text row with nothing typed asks for text instead of submitting the ticks
        if (cursor === options.length) keys.push(KEY.up);
        return keySteps([...keys, KEY.enter]);
      },
    } : {}),
  }, { default_option_indices: undefined, can_step_back: undefined, can_step_next: undefined });
}

/** Whether the panel's option-list hint is the last thing above dsh-tui's own footer. */
export function dshQuestionActive(screen: string): boolean {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map(cleanLine).filter(Boolean);
  // dsh-tui keeps its context meter, status line and interrupt hint under the panel
  return lines.slice(-8).some((_, at, tail) => {
    const hint = tail.slice(at, at + DSH_HINT_LINES).join(" ");
    return DSH_HINT_RE.test(hint) || DSH_TYPING_HINT_RE.test(hint);
  });
}

export const readers: readonly DialogReader[] = [{
  id: "dsh-question",
  agents: ["dsh-tui"],
  priority: 10,
  // the cursor is read off the screen: a row moved to in the terminal since the card was drawn is looked at again before Enter
  reread: "before-commit",
  list: "none",
  parse: (screen) => parseDshQuestion(screen),
}];
