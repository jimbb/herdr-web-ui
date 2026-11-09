import type { DialogReader } from "./registry.ts";
import {
  ANSI_RE,
  KEY,
  SOLID_RULE_RE,
  cleanLine,
  findLastIndex,
  finishPrompt,
  isDivider,
  joinWrapped,
  keySteps,
  navigationKeys,
  own,
  screenWidth,
  wrapped,
  type ParsedPrompt,
} from "./shared.ts";

/**
 * Antigravity CLI's (`agy`) `ask_question` TUI (`third_party/jetski/cli/model/ask_question.go`):
 *
 *   Question
 *   ────────────────────────────────────────
 *
 *   Question 1/2: Which test runner should we use?
 *
 *   ▸ 1. (Recommended) Bun test
 *     2. Vitest
 *     3. Write-in...
 *
 *   ↑/↓ Navigate · → Next · enter Submit · esc Skip
 *
 * Multi-select questions prefix each choice with `[x] ` or `[ ] ` (never the `Write-in...` row)
 * and add `space Toggle` to the hint bar. Questions revisited with `← Back` after a single-choice
 * answer prefix the chosen row with `✓ `.
 */
export const AGY_ASK_HINT_RE = /↑\/↓\s+Navigate\b[\s\S]*?\benter\s+(?:Submit(?:\s+All)?|Write-in)\b[\s\S]*?\besc\s+Skip\b/i;

const AGY_WRITE_IN_HINT_RE = /\benter\s+Submit(?:\s+All)?\s*·\s*esc\s+Back\b/i;
const AGY_QUESTION_RE = /^Question\s+(\d+)\/(\d+):\s*(.+)$/;
const AGY_ROW_RE = /^\s*([▸❯›>])?\s*(\d+)\.\s+(.+)$/;
const AGY_WRITE_IN = "Write-in...";

/**
 * Whether `agy`'s inline `Write-in...` text input owns the keyboard (`Your answer:` over
 * `enter Submit · esc Back`). While open, arrows and Enter go to that text input rather than
 * the option rows, so no fallback menu card may guess keys into it.
 */
export function agyWriteInWaits(screen: string): boolean {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const shown = lines.map(cleanLine).filter(Boolean);
  if (!shown.slice(-6).some((_, at, tail) => AGY_WRITE_IN_HINT_RE.test(tail.slice(at, at + 3).join(" ")))) return false;
  const hintIndex = findLastIndex(lines, (_, index) => AGY_WRITE_IN_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return false;
  return lines.slice(Math.max(0, hintIndex - 12), hintIndex).some((line) => cleanLine(line) === "Your answer:");
}

/**
 * Parses `agy`'s live `ask_question` prompt screen into an `InteractivePrompt`, or returns null
 * when the screen does not show a complete, unambiguous `ask_question` menu.
 */
export function parseAgyQuestion(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const shown = lines.map(cleanLine).filter(Boolean);
  if (!shown.slice(-6).some((_, at, tail) => AGY_ASK_HINT_RE.test(tail.slice(at, at + 3).join(" ")))) return null;
  const hintIndex = findLastIndex(lines, (_, index) => AGY_ASK_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;

  let headerIndex = -1;
  for (let index = hintIndex - 1; index >= Math.max(0, hintIndex - 64); index -= 1) {
    if (cleanLine(lines[index]!) === "Question" && SOLID_RULE_RE.test(cleanLine(lines[index + 1] ?? ""))) {
      headerIndex = index;
      break;
    }
  }
  if (headerIndex < 0) return null;

  let questionStart = headerIndex + 2;
  while (questionStart < hintIndex && !cleanLine(lines[questionStart]!)) questionStart += 1;
  const headerMatch = cleanLine(lines[questionStart] ?? "").match(AGY_QUESTION_RE);
  if (!headerMatch) return null;
  const n = Number.parseInt(headerMatch[1]!, 10);
  const total = Number.parseInt(headerMatch[2]!, 10);
  if (!Number.isInteger(n) || !Number.isInteger(total) || n < 1 || total < n) return null;

  let questionEnd = questionStart + 1;
  while (questionEnd < hintIndex) {
    const raw = lines[questionEnd]!.replace(ANSI_RE, "");
    const line = cleanLine(raw);
    if (!line || isDivider(raw) || AGY_ROW_RE.test(raw)) break;
    questionEnd += 1;
  }
  const width = screenWidth(lines);
  const question = joinWrapped(lines.slice(questionStart, questionEnd), width, /^Question\s+\d+\/\d+:\s*/);
  if (!question) return null;

  let optionsStart = questionEnd;
  while (optionsStart < hintIndex && !cleanLine(lines[optionsStart]!)) optionsStart += 1;
  const rows: { selected: boolean; box: boolean; checked: boolean; answered: boolean; rawLines: string[] }[] = [];
  let optionsEnd = optionsStart;
  for (; optionsEnd < hintIndex; optionsEnd += 1) {
    const raw = lines[optionsEnd]!.replace(ANSI_RE, "");
    const clean = cleanLine(raw);
    if (!clean) break;
    if (isDivider(raw)) return null;
    const match = raw.match(AGY_ROW_RE);
    if (match) {
      if (Number.parseInt(match[2]!, 10) !== rows.length + 1) return null;
      const rest = match[3]!.trim();
      const boxMatch = rest.match(/^\[([xX ])\]\s+(.*)$/);
      const checkMatch = boxMatch ? null : rest.match(/^✓\s+(.*)$/);
      const text = (boxMatch?.[2] ?? checkMatch?.[1] ?? rest).trim();
      if (!text) return null;
      rows.push({
        selected: Boolean(match[1]),
        box: Boolean(boxMatch),
        checked: boxMatch?.[1]?.toLowerCase() === "x",
        answered: Boolean(checkMatch),
        rawLines: [text],
      });
      continue;
    }
    if (rows.length === 0) return null;
    rows.at(-1)!.rawLines.push(clean);
  }
  if (lines.slice(optionsEnd, hintIndex).some((line) => cleanLine(line) !== "")) return null;

  const namedRows = rows.map((row) => ({ ...row, label: joinWrapped(row.rawLines, width) }));
  if (namedRows.length < 2 || namedRows.some((row) => !row.label) || namedRows.filter((row) => row.selected).length !== 1) return null;
  const writeIn = namedRows.at(-1)!;
  if (writeIn.label !== AGY_WRITE_IN || writeIn.box || writeIn.answered) return null;
  const choices = namedRows.slice(0, -1);
  const hint = wrapped(lines, hintIndex);
  const multi = choices.every((row) => row.box);
  if (!multi && choices.some((row) => row.box)) return null;
  if (multi !== /\bspace\s+Toggle\b/i.test(hint)) return null;

  const selectedIndex = namedRows.findIndex((row) => row.selected);
  const checked = choices.flatMap((row, index) => row.checked ? [index] : []);
  const answeredIndex = !multi ? choices.findIndex((row) => row.answered) : -1;
  const at = n - 1;
  const back = total > 1 && at > 0 && /←\s+Back\b/i.test(hint);
  const next = total > 1 && at < total - 1 && /→\s+Next\b/i.test(hint);
  const navigates = back || next;
  const title = total > 1 ? own("Question {n} of {total}", { n: String(n), total: String(total) }) : own("Question");

  return finishPrompt("agy", {
    kind: "question",
    title,
    question,
    body: null,
    options: choices.map((row) => ({ label: row.label, description: null })),
    multi_select: multi,
    custom_option_index: multi ? null : choices.length,
    ...(answeredIndex >= 0 ? { default_option_index: answeredIndex } : {}),
    ...(checked.length > 0 ? { default_option_indices: checked } : {}),
    ...(back ? { can_step_back: true } : {}),
    ...(next ? { can_step_next: true } : {}),
  }, {
    ...(navigates ? { nativeSteps: { identity: `agy:${total}`, index: at, count: total, next: KEY.right, previous: KEY.left } } : {}),
    responder: "agy-question",
    menuLabels: namedRows.map((row) => row.label),
    selectedIndex,
    checkedOptionIndices: checked,
    customMenuIndex: multi ? null : choices.length,
    rejectWithEscapeIndex: null,
    ...(multi ? {} : {
      customSteps: (text: string) => [
        ...keySteps([...navigationKeys(choices.length - selectedIndex), KEY.enter]),
        { text: text.replace(/\s*\r?\n\s*/g, " ").trim() },
        ...keySteps([KEY.enter]),
      ],
    }),
    ...(multi ? {
      multiSteps: (picked: number[]) => {
        const want = new Set(picked);
        let cursor = selectedIndex;
        const keys: string[] = [];
        for (const index of choices.keys()) {
          if (want.has(index) === checked.includes(index)) continue;
          keys.push(...navigationKeys(index - cursor), KEY.space);
          cursor = index;
        }
        // Enter on Write-in... opens the inline text input instead of submitting the checked choices.
        if (cursor === choices.length) keys.push(KEY.up);
        return keySteps([...keys, KEY.enter]);
      },
    } : {}),
  }, { can_step_back: undefined, can_step_next: undefined, default_option_index: undefined, default_option_indices: undefined });
}

export const readers: readonly DialogReader[] = [{
  id: "agy-question",
  agents: ["agy"],
  priority: 10,
  reread: "none",
  list: "none",
  parse(screen) {
    return parseAgyQuestion(screen);
  },
}];
