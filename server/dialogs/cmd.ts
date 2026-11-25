import type { InteractivePromptAnswer } from "../../shared/protocol.ts";
import type { DialogReader } from "./registry.ts";
import { ANSI_RE, KEY, type CardWords, type ParsedPrompt, cleanLine, findLastIndex, finishPrompt, isDivider, joinWrapped, keySteps, navigationKeys, own, type PromptDraft } from "./shared.ts";

/** Command Code's permission footer, retained for the terminal-owned permission reader. */
export function cmdFooterStart(lines: string[]): number {
  const at = findLastIndex(lines, (line) => /^\s*↑/.test(line));
  if (at < 0) return -1;
  const footer = lines.slice(at).join("").replace(/\s/g, "");
  return /^↑\/↓navigate·enterselect(?:·ctrl\+[ey]explain)?·Runcmd--yolotobypassallpermissions\(Docs↗\)$/i.test(footer) ? at : -1;
}

/** Command Code's ask_user_question footer, wrapped by Ink at narrow widths. */
export function cmdQuestionFooterStart(lines: string[]): number {
  const at = findLastIndex(lines, (line) => /^\s*Enter to select\s*\|\s*Arrow keys to navigate\s*\|/i.test(cleanLine(line)));
  if (at < 0) return -1;
  const footer = lines.slice(at).join("").replace(/\s/g, "");
  return /^Entertoselect\|Arrowkeystonavigate\|1-9quickselect\|nnotes\|cchat\|Esctocancel$/i.test(footer) ? at : -1;
}

/** While the inline free-text editor is focused Command Code hides the key footer. */
export function cmdQuestionPanelActive(lines: string[]): boolean {
  if (cmdQuestionFooterStart(lines) >= 0) return true;
  const last = findLastIndex(lines, (line) => cleanLine(line) !== "");
  return last >= 0 && /^\s*[❯›>]\s*\d+\.\s+Type something\.{3}$/i.test(lines[last]!);
}

const CMD_TAB_RE = /^[✔●◯]\s+(.+?)(?:\s+\|\s+[✔●◯]\s+.+)+$/;
const CMD_ROW_RE = /^\s*([❯›>])?\s*(\d+)\.\s+(?:(\[[ xX✔]\])\s*)?(.+?)\s*$/;
const CMD_REVIEW_BACK_RE = /^←\s+to go back and edit$/i;

interface CmdTab { label: string; marker: "answered" | "current" | "open" }

function commandTabs(lines: string[], before: number): { index: number; tabs: CmdTab[] } | null {
  for (let index = before - 1; index >= Math.max(0, before - 20); index -= 1) {
    const line = cleanLine(lines[index]!);
    if (!CMD_TAB_RE.test(line)) continue;
    const tabs = line.split("|").map((cell) => {
      const match = /^\s*([✔●◯])\s+(.+?)\s*$/.exec(cell)!;
      const marker: CmdTab["marker"] = match[1] === "✔" ? "answered" : match[1] === "●" ? "current" : "open";
      return { label: match[2]!, marker };
    });
    if (tabs.length >= 2 && tabs.at(-1)?.label === "Review") return { index, tabs };
  }
  return null;
}

function cmdSteps(tabs: { tabs: CmdTab[] }, current: number): Pick<PromptDraft, "steps" | "can_step_back" | "can_step_next"> & { nativeSteps: NonNullable<ParsedPrompt["nativeSteps"]> } {
  const labels = tabs.tabs.map((tab) => tab.label);
  return {
    steps: tabs.tabs.map((tab, index) => ({ label: tab.label, answered: tab.marker === "answered", current: index === current, ...(index !== current ? { can_navigate: true } : {}) })),
    can_step_back: current > 0,
    can_step_next: current < tabs.tabs.length - 1,
    nativeSteps: { identity: JSON.stringify(labels), index: current, count: labels.length, next: KEY.right, previous: KEY.left },
  };
}

interface CmdRow {
  number: number;
  label: string;
  description: string | null;
  selected: boolean;
  checked: boolean;
  answered: boolean;
  lineIndex: number;
}

function commandRows(lines: string[], start: number, end: number): CmdRow[] {
  const rows: CmdRow[] = [];
  for (let index = start; index < end; index += 1) {
    const match = CMD_ROW_RE.exec(lines[index]!);
    if (!match) continue;
    const answered = /\s+✔$/.test(match[4]!);
    const row: CmdRow = {
      number: Number(match[2]), label: match[4]!.replace(/^\[.\]\s*/, "").replace(/\s+✔$/, "").trim(), description: null,
      selected: match[1] !== undefined, checked: match[3] === "[✔]", answered, lineIndex: index,
    };
    const description: string[] = [];
    for (let line = index + 1; line < end && !CMD_ROW_RE.test(lines[line]!) && !/^\s*Submit\s*$/.test(lines[line]!) && lines[line]!.trim() !== ""; line += 1) {
      if (isDivider(lines[line]!)) break;
      description.push(cleanLine(lines[line]!));
    }
    row.description = description.length > 0 ? joinWrapped(description, Math.max(1, ...lines.map((line) => Bun.stringWidth(line)))) : null;
    rows.push(row);
  }
  return rows;
}

function questionText(lines: string[], firstRow: number, tabsIndex: number): string | null {
  for (let index = firstRow - 1; index > tabsIndex; index -= 1) {
    const line = cleanLine(lines[index]!);
    if (line && !isDivider(line)) return line;
  }
  return null;
}

function cmdReviewAnswers(lines: string[], from: number, submitRow: number): InteractivePromptAnswer[] | null {
  const answers: InteractivePromptAnswer[] = [];
  for (let index = from; index < submitRow; index += 1) {
    const match = /^\s*(\d+)\.\s+(.+)$/.exec(lines[index]!);
    if (!match) continue;
    const answer = lines[index + 1]?.trim();
    answers.push({ question: match[2]!.trim(), answer: answer && !/^\d+\./.test(answer) ? answer : null });
  }
  return answers.length > 0 ? answers : null;
}

function parseCmdSubmit(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  if (cmdQuestionFooterStart(lines) >= 0) return null;
  const back = findLastIndex(lines, (line) => CMD_REVIEW_BACK_RE.test(cleanLine(line)));
  if (back < 0) return null;
  const tabs = commandTabs(lines, back);
  if (!tabs || tabs.tabs.at(-1)?.marker !== "current") return null;
  const submitRow = findLastIndex(lines, (line, index) => index < back && /^\s*(?:[❯›>])?\s*1\.\s+Submit\s*$/.test(line));
  if (submitRow < 0 || !/^\s*(?:[❯›>])?\s*2\.\s+Cancel\s*$/.test(lines[submitRow + 1] ?? "")) return null;
  const selected = [lines[submitRow]!, lines[submitRow + 1]!].filter((line) => /^\s*[❯›>]/.test(line)).length;
  if (selected !== 1) return null;
  const current = tabs.tabs.length - 1;
  const navigation = cmdSteps(tabs, current);
  return finishPrompt("cmd", {
    kind: "menu", title: "Review", question: "Review", body: null,
    options: [{ label: own("Submit"), description: null }, { label: own("Cancel"), description: null }],
    multi_select: false, custom_option_index: null, answers: cmdReviewAnswers(lines, tabs.index + 1, submitRow) ?? undefined,
    steps: navigation.steps, can_step_back: true,
  }, {
    responder: "cmd-submit", menuLabels: ["Submit", "Cancel"], selectedIndex: lines[submitRow]!.includes("❯") ? 0 : 1,
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null, nativeSteps: navigation.nativeSteps,
  }, { steps: undefined, can_step_back: undefined, can_step_next: undefined });
}

function parseCmdQuestion(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const footer = cmdQuestionFooterStart(lines);
  const end = footer >= 0 ? footer : findLastIndex(lines, (line) => cleanLine(line) !== "") + 1;
  if (footer < 0 && !cmdQuestionPanelActive(lines)) return null;
  const firstRow = lines.findIndex((line, index) => index < end && CMD_ROW_RE.test(line));
  if (firstRow < 0) return null;
  const tabs = commandTabs(lines, firstRow);
  const rows = commandRows(lines, firstRow, end);
  if (rows.length < 2 || !rows.every((row, index) => row.number === index + 1)) return null;
  const submit = findLastIndex(lines, (line, index) => index > firstRow && index < end && /^\s*Submit\s*$/.test(line));
  const hasSubmit = submit >= 0;
  const customRow = rows.at(-1)!;
  if (!/^Type something\.{3}$/i.test(customRow.label)) return null;
  const optionRows = rows.slice(0, -1);
  const multi = optionRows.some((row) => row.checked || /\[[ xX✔]\]/.test(lines[row.lineIndex]!));
  if (hasSubmit !== multi) return null;
  const selectedRows = rows.filter((row) => row.selected);
  const submitSelected = hasSubmit && /^\s*[❯›>]/.test(lines[submit]!);
  if (selectedRows.length + (submitSelected ? 1 : 0) !== 1) return null;
  const selectedIndex = submitSelected ? optionRows.length + 1 : selectedRows[0]!.number - 1;
  const tabsInfo = tabs && tabs.tabs.at(-1)?.marker !== "current" ? tabs : null;
  const current = tabsInfo?.tabs.findIndex((tab) => tab.marker === "current") ?? -1;
  if (tabsInfo && current < 0 || tabsInfo && current === tabsInfo.tabs.length - 1) return null;
  const question = questionText(lines, firstRow, tabsInfo?.index ?? -1);
  if (!question) return null;
  const navigation = tabsInfo ? cmdSteps(tabsInfo, current) : null;
  const title: CardWords = navigation && tabsInfo
    ? own("{label} · {n} of {total}", { label: tabsInfo.tabs[current]!.label, n: current + 1, total: tabsInfo.tabs.length - 1 })
    : own(multi ? "Multiple choice" : "Question");
  const draft: PromptDraft = {
    kind: "question", title, question, body: null,
    options: optionRows.map((row) => ({ label: row.label, description: row.description })),
    multi_select: multi, ...(multi ? { checks_with_text: true as const } : {}),
    custom_option_index: optionRows.length,
    ...(multi && optionRows.some((row) => row.checked) ? { default_option_indices: optionRows.flatMap((row, index) => row.checked ? [index] : []) } : {}),
    ...(optionRows.findIndex((row) => row.answered) >= 0 ? { default_option_index: optionRows.findIndex((row) => row.answered) } : {}),
    ...(navigation ? { steps: navigation.steps, can_step_back: navigation.can_step_back, can_step_next: navigation.can_step_next } : {}),
  };
  const internal: Parameters<typeof finishPrompt>[2] = {
    ...(navigation ? { nativeSteps: navigation.nativeSteps } : {}), responder: "cmd-question",
    menuLabels: [...optionRows.map((row) => row.label), customRow.label, ...(hasSubmit ? ["Submit"] : [])], selectedIndex,
    checkedOptionIndices: optionRows.flatMap((row, index) => row.checked ? [index] : []), customMenuIndex: optionRows.length,
    rejectWithEscapeIndex: null,
    customSteps: (text: string, picked?: number[]) => {
      const keys: string[] = [];
      let cursor = selectedIndex;
      if (multi && picked !== undefined) {
        const wanted = new Set(picked);
        for (const index of optionRows.keys()) {
          if (wanted.has(index) === optionRows[index]!.checked) continue;
          keys.push(...navigationKeys(index - cursor), KEY.space);
          cursor = index;
        }
      }
      keys.push(...navigationKeys(optionRows.length - cursor));
      return [...keySteps(keys), { text: text.replace(/\s*\r?\n\s*/g, " ").trim() }, ...keySteps(multi ? [KEY.enter, KEY.down, KEY.enter] : [KEY.enter])];
    },
    ...(multi ? { multiSteps: (picked: number[]) => {
      const wanted = new Set(picked);
      const keys: string[] = [];
      let cursor = selectedIndex;
      for (const index of optionRows.keys()) {
        if (wanted.has(index) === optionRows[index]!.checked) continue;
        keys.push(...navigationKeys(index - cursor), KEY.space);
        cursor = index;
      }
      keys.push(...navigationKeys(optionRows.length + 1 - cursor), KEY.enter);
      return keySteps(keys);
    } } : {}),
  };
  return finishPrompt("cmd", draft, internal, { body: lines.slice(0, firstRow).join("\n"), steps: undefined, can_step_back: undefined, can_step_next: undefined, default_option_index: undefined });
}

function parseCmdPermission(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = cmdFooterStart(lines);
  if (hintIndex < 0) return null;
  let blockStart = hintIndex;
  while (blockStart > 0 && lines[blockStart - 1]!.trim() === "") blockStart -= 1;
  while (blockStart > 0) {
    const prev = lines[blockStart - 1]!;
    if (isDivider(prev) || prev.trim() === "") break;
    if (/^\s*[❯›>]?\s*\d+\.\s+/.test(prev)) { blockStart -= 1; continue; }
    if (/^\s+\S/.test(prev) && !/^\s*[❯›>]?\s*\d+\.\s+/.test(prev)) { blockStart -= 1; continue; }
    break;
  }
  const rows: { label: string; selected: boolean; number: number }[] = [];
  for (let index = blockStart; index < hintIndex; index += 1) {
    const match = /^\s*([❯›>])?\s*(\d+)\.\s+(.+)$/.exec(lines[index]!);
    if (!match) continue;
    const row = { label: match[3]!.trim(), selected: match[1] !== undefined, number: Number(match[2]) };
    let next = index + 1;
    while (next < hintIndex && !/^\s*[❯›>]?\s*\d+\.\s+/.test(lines[next]!) && !/↑\/↓/.test(lines[next]!) && lines[next]!.trim() !== "" && !isDivider(lines[next]!)) {
      row.label = (row.label + " " + lines[next]!.trim()).trim();
      next += 1;
    }
    rows.push(row);
  }
  if (rows.length < 2) return null;
  if (!rows.every((row, index) => row.number === index + 1)) return null;
  // the cursor must be marked on exactly one row: without it the chat cannot tell which option
  // an answer would land on, and Command Code may mark the cursor by colour alone
  if (rows.filter((row) => row.selected).length !== 1) return null;
  // The source-defined permission choices begin with Yes and end with No, not arbitrary menu labels.
  if (rows[0]?.label !== "Yes" || !/^No(?:,|$)/.test(rows.at(-1)?.label ?? "")) return null;
  const selectedIndex = rows.findIndex((row) => row.selected);
  const firstRowIndex = lines.findIndex((line, index) => index >= blockStart && /^\s*[❯›>]?\s*1\.\s+/.test(line));
  let title: CardWords = own("Permission request");
  let titleIndex = -1;
  if (firstRowIndex >= 0) {
    let index = firstRowIndex - 1;
    while (index >= 0) {
      const cleaned = cleanLine(lines[index]!);
      if (cleaned === "") { index -= 1; continue; }
      if (isDivider(cleaned)) break;
      if (/Do you want to .+\?/i.test(cleaned)) { index -= 1; continue; }
      if (/needs to (execute|run|approve|create|edit|write|delete)/i.test(cleaned)) { index -= 1; continue; }
      if (/ctrl\+e/i.test(cleaned) && /explain/i.test(cleaned)) { index -= 1; continue; }
      if (/[;|]|2>\/dev\/null|head -\d/.test(cleaned)) { index -= 1; continue; }
      if (cleaned) title = cleaned;
      break;
    }
    titleIndex = index;
  }
  let question = title;
  if (firstRowIndex >= 0) {
    for (let index = firstRowIndex - 1; index >= 0; index -= 1) {
      const cleaned = cleanLine(lines[index]!);
      if (cleaned === "") continue;
      if (isDivider(cleaned)) break;
      if (/Do you want to .+\?/i.test(cleaned) || /needs to (execute|run|approve|create|edit|write|delete)/i.test(cleaned)) { question = cleaned; break; }
    }
  }
  // the body: what the agent wants to do (the command, the file), every line of the dialog between
  // its title and the rows but the question, so a command shown above the question is in the card's
  // id too: a command replaced under the card makes it stale instead of approving the new one
  const bodyLines = firstRowIndex >= 0 ? lines.slice(titleIndex + 1, firstRowIndex) : [];
  const body = bodyLines.map(cleanLine).filter((line) => line && line !== question && !isDivider(line) && !/ctrl\+e/i.test(line)).join("\n") || null;
  // The id hashes the whole screen above the rows as drawn, not only the title and body the card
  // shows: where the dialog starts is a guess (a heredoc can hold a rule; its indentation is part of
  // the command), so any change above the rows makes the card stale. Output that changes there while
  // the dialog is open makes it stale too, and the answer goes to the terminal instead.
  const dialog = lines.slice(0, firstRowIndex).join("\n");
  return finishPrompt("cmd", {
    kind: "approval", title, question, body,
    options: rows.map((row) => ({ label: row.label, description: null })),
    multi_select: false,
    custom_option_index: null,
  }, {
    responder: "cmd-question",
    menuLabels: rows.map((row) => row.label),
    selectedIndex,
    checkedOptionIndices: [],
    customMenuIndex: null,
    rejectWithEscapeIndex: null,
  }, { body: dialog });
}

export const readers: readonly DialogReader[] = [
  {
    id: "cmd-question", agents: ["cmd"], priority: 10,
    reread: "before-commit", list: "none",
    parse: (screen) => {
      const parsed = parseCmdQuestion(screen) ?? parseCmdPermission(screen);
      return parsed?.responder === "cmd-question" ? parsed : null;
    },
  },
  {
    id: "cmd-submit", agents: ["cmd"], priority: 20,
    reread: "before-commit", list: "none",
    parse: (screen) => {
      const parsed = parseCmdSubmit(screen);
      return parsed?.responder === "cmd-submit" ? parsed : null;
    },
  },
];
