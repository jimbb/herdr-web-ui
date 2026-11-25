import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { answerKeys, parseInteractivePrompt } from "../prompt.ts";

const screen = (name: string) => readFileSync(join(import.meta.dir, "..", "fixtures", `cmd-question-1.93.3-${name}.txt`), "utf8");
const fixture = (name: string) => screen(name);

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

  it("reads a one-question panel without the optional footer and its Review page", () => {
    const prompt = parseInteractivePrompt("cmd", fixture("single"));
    expect(prompt).toMatchObject({ title: "Pet · 1 of 1", question: "Which pet do you want?", custom_option_index: 2 });
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    const review = parseInteractivePrompt("cmd", fixture("single-review"));
    expect(review).toMatchObject({ kind: "menu", title: "Review", answers: [{ question: "Which pet do you want?", answer: "Cat" }] });
  });

  it("accepts Next on a non-final multi-select question", () => {
    const middle = screen("2").replace("✔ Colour | ● Sizes | ◯ Review", "● Sizes | ◯ Colour | ◯ Review").replace("  Submit", "  Next");
    const prompt = parseInteractivePrompt("cmd", middle);
    expect(prompt).toMatchObject({ multi_select: true, question: "Which sizes do you want?", can_step_next: true });
    expect(answerKeys(prompt!, { option_indices: [1] })).toEqual([{ keys: ["down"] }, { keys: ["space"] }, { keys: ["down"] }, { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);
  });

  it("leaves hideCustomInput panels to the terminal instead of guessing a card", () => {
    const hidden = screen("single").replace("● Pet | ◯ Review\n\n", "").replace(/\n  3\. Type something\.\.\.$/, "");
    expect(parseInteractivePrompt("cmd", hidden)).toBeNull();
  });

  it("does not keep a question card after later output", () => {
    expect(parseInteractivePrompt("cmd", screen("stale"))).toBeNull();
  });
});
