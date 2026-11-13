import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { answerKeys, parseInteractivePrompt } from "../prompt.ts";
import { parsedByPublicPrompt } from "./shared.ts";
import { registry } from "./registry.ts";

// recorded from dsh-tui 0.20.0 in a 100x50 tmux pane (narrow: 52 columns), ask_user_question asked by dsh-deepseek-flash
const screen = (name: string) => readFileSync(join(import.meta.dir, "..", "fixtures", `dsh-question-0.20.0-${name}.txt`), "utf8");

const HEADLESS = [
  { label: "Device + WebDriverAgent (Recommended)", description: "Uses iphone172 and the MacBook; no App Attest workaround, no ToS risk, durable." },
  { label: "Dev API + Firebase token", description: "No hardware, but depends on an unprotected staging API." },
];

describe("DeepSeek Harness ask_user_question panel", () => {
  it("is read for dsh-tui panes only", () => {
    expect(registry.readersFor("dsh-tui").map((reader) => reader.id)).toContain("dsh-question");
    expect(registry.readersFor("claude").map((reader) => reader.id)).not.toContain("dsh-question");
  });

  it.each(["q1", "narrow-52"])("reads the question, its options with their descriptions and the free-text row (%s)", (name) => {
    const prompt = parseInteractivePrompt("dsh-tui", screen(name));
    expect(prompt).toMatchObject({
      kind: "question", question: "Which headless approach should I build?", multi_select: false,
      options: HEADLESS, custom_option_index: 2,
    });
    expect(prompt?.fallback).toBeUndefined();
    expect(parsedByPublicPrompt.get(prompt!)?.responder).toBe("dsh-question");
  });

  it("shows the header chip over the question", () => {
    expect(parseInteractivePrompt("dsh-tui", screen("q1"))?.body).toBe("Choose Approach");
  });

  it("answers from wherever the cursor stands: moves, then Enter", () => {
    expect(answerKeys(parseInteractivePrompt("dsh-tui", screen("q1"))!, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(parseInteractivePrompt("dsh-tui", screen("q1-down"))!, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
    expect(answerKeys(parseInteractivePrompt("dsh-tui", screen("q1-custom"))!, { option_index: 1 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
  });

  it("types a custom answer on the free-text row, never Enter first (it would only ask for text)", () => {
    expect(answerKeys(parseInteractivePrompt("dsh-tui", screen("q1"))!, { custom_text: "node --test" }))
      .toEqual([{ keys: ["down"] }, { keys: ["down"] }, { text: "node --test" }, { keys: ["enter"] }]);
    expect(answerKeys(parseInteractivePrompt("dsh-tui", screen("q1-custom"))!, { custom_text: "a\nb" }))
      .toEqual([{ text: "a b" }, { keys: ["enter"] }]);
  });

  it("refuses the panel once text was typed into its free-text row in the terminal", () => {
    const typed = screen("q1-custom").replace(/(✎ Custom answer：)\s*$/m, "$1node");
    expect(parseInteractivePrompt("dsh-tui", typed)).toBeNull();
  });

  it("reads a multiple choice of a batch, its ticks and its question switch", () => {
    const first = parseInteractivePrompt("dsh-tui", screen("multi-q1"))!;
    expect(first).toMatchObject({
      question: "Which platforms should we test?", body: "Platforms", multi_select: true, custom_option_index: null,
      options: [{ label: "iOS" }, { label: "Android" }, { label: "Web" }], can_step_next: true,
    });
    expect(first.can_step_back).toBeUndefined();
    expect(answerKeys(first, { option_indices: [0, 2] }))
      .toEqual([{ keys: ["space"] }, { keys: ["down"] }, { keys: ["down"] }, { keys: ["space"] }, { keys: ["enter"] }]);
    const ticked = parseInteractivePrompt("dsh-tui", screen("multi-q1-checked"))!;
    expect(ticked.default_option_indices).toEqual([0, 2]);
    expect(answerKeys(ticked, { option_indices: [0, 2] })).toEqual([{ keys: ["enter"] }]);
    // the cursor is on Web: iOS unticked, Android ticked, Web unticked, in row order
    expect(answerKeys(ticked, { option_indices: [1] })).toEqual([
      { keys: ["up"] }, { keys: ["up"] }, { keys: ["space"] }, { keys: ["down"] }, { keys: ["space"] },
      { keys: ["down"] }, { keys: ["space"] }, { keys: ["enter"] },
    ]);
  });

  it("reads the batch's last question with a way back", () => {
    expect(parseInteractivePrompt("dsh-tui", screen("multi-q2"))).toMatchObject({
      question: "Which runner?", multi_select: false, custom_option_index: 2, can_step_back: true,
      options: [{ label: "Bun test" }, { label: "Vitest" }],
    });
  });

  it("is no card once the panel is answered and the conversation goes on under it", () => {
    expect(parseInteractivePrompt("dsh-tui", `${screen("q1")}\n  ● Answers received.\n  ╭────╮\n  ⌸ ❯\n  ╰────╯\n${"  more output\n".repeat(10)}`)).toBeNull();
  });
});
