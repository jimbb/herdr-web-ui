import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { answerKeys, parseInteractivePrompt } from "../prompt.ts";

const screen = (name: string) => readFileSync(join(import.meta.dir, "..", "fixtures", `cmd-question-1.93.3-${name}.txt`), "utf8");

describe("Command Code 1.93.3 ask_user_question", () => {
  it("reads a single-select question and its descriptions", () => {
    const prompt = parseInteractivePrompt("cmd", screen("1"));
    expect(prompt).toMatchObject({
      kind: "question", title: "Colour · 1 of 2", question: "Which colour do you prefer?", multi_select: false,
      custom_option_index: 3,
      options: [
        { label: "Red", description: "Pick red as your preferred colour." },
        { label: "Green", description: "Pick green as your preferred colour." },
        { label: "Blue", description: "Pick blue as your preferred colour." },
      ],
    });
    expect(answerKeys(prompt!, { option_index: 2 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);
  });

  it("reads a checked multi-select question and submits its ticks", () => {
    const prompt = parseInteractivePrompt("cmd", screen("3"));
    expect(prompt).toMatchObject({ kind: "question", question: "Which sizes do you want?", multi_select: true, custom_option_index: 3, default_option_indices: [1] });
    expect(answerKeys(prompt!, { option_indices: [1] })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(prompt!, { option_indices: [1], custom_text: "for the guest room" })).toEqual([
      { keys: ["down"] }, { keys: ["down"] }, { text: "for the guest room" }, { keys: ["enter"] }, { keys: ["down"] }, { keys: ["enter"] },
    ]);
  });

  it("types a free-text answer while Command Code hides its footer", () => {
    const prompt = parseInteractivePrompt("cmd", screen("free-text"));
    expect(prompt).toMatchObject({ question: "What color do you prefer?", default_option_index: 0, custom_option_index: 2 });
    expect(answerKeys(prompt!, { custom_text: "purple" })).toEqual([{ text: "purple" }, { keys: ["enter"] }]);
  });

  it("reads the Review tab as a submit menu and preserves the answers", () => {
    const prompt = parseInteractivePrompt("cmd", screen("4"));
    expect(prompt).toMatchObject({ kind: "menu", title: "Review", question: "Review", options: [{ label: "Submit" }, { label: "Cancel" }] });
    expect(prompt?.answers).toEqual([
      { question: "Which colour do you prefer?", answer: "Red" },
      { question: "Which sizes do you want?", answer: "Medium" },
    ]);
    expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
  });

  it("does not keep a question card after later output", () => {
    expect(parseInteractivePrompt("cmd", screen("stale"))).toBeNull();
  });
});
