/**
 * The mode a new Claude Code or Codex agent starts in (Settings > Chat > New agents), as the
 * arguments herdr's `agent start` passes after `--`. "default" adds none, so the agent follows
 * its own configuration; an older agent that lacks a mode refuses to start and says why.
 *
 * Besides its mode, a launch from the new workspace/tab dialogs and the agent queue may name a
 * model and an effort level, turn on Claude Code's Ultracode, and start on a first prompt
 * (#774, #1311, #2232), each only where the agent's own CLI reference documents the flag or
 * argument (launchCapabilities); nothing is guessed for the rest. The bridge checks them again
 * by the same rules (shared/launch-rules.ts).
 */
import { hasNoControlCharacters, CLAUDE_EFFORTS, CLAUDE_ULTRACODE_SETTINGS, CODEX_EFFORTS, DSH_EFFORTS, MODEL_NAME } from "./launch-rules.ts";
import type { SharedPreferences } from "./preferences.ts";

export { CLAUDE_EFFORTS, CODEX_EFFORTS };

/** Claude Code's `--permission-mode` choices; "default" leaves the flag out */
export const CLAUDE_LAUNCH_MODES = ["default", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"] as const;
export type ClaudeLaunchMode = (typeof CLAUDE_LAUNCH_MODES)[number];

/** Codex's `/approvals` presets, each a sandbox and an approval policy; "default" leaves both out */
export const CODEX_LAUNCH_MODES = ["default", "readOnly", "auto", "fullAccess"] as const;
export type CodexLaunchMode = (typeof CODEX_LAUNCH_MODES)[number];

const CODEX_ARGS: Record<Exclude<CodexLaunchMode, "default">, string[]> = {
  readOnly: ["--sandbox", "read-only", "--ask-for-approval", "on-request"],
  auto: ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
  fullAccess: ["--sandbox", "danger-full-access", "--ask-for-approval", "never"],
};

/** What a new agent's launch takes besides its mode, as its own CLI reference documents it. */
export interface LaunchCapabilities {
  /** a model name goes on the command line (`--model`) */
  model: boolean;
  /** the effort levels the agent names; empty: its launch takes none */
  efforts: readonly string[];
  /** Claude Code's Ultracode switch goes on the command line as one inline `--settings` object */
  ultracode: boolean;
  /**
   * the first prompt goes on the command line after an end-of-options separator, which the agent's
   * parser verifiably takes as the prompt and never as a subcommand or a flag; otherwise the bridge
   * queues the message for the agent's first ready turn (POST .../create `first_message`)
   */
  positionalPrompt: boolean;
}

const NO_CAPABILITIES: LaunchCapabilities = { model: false, efforts: [], ultracode: false, positionalPrompt: false };

const CAPABILITIES: Readonly<Record<string, LaunchCapabilities>> = {
  claude: { model: true, efforts: CLAUDE_EFFORTS, ultracode: true, positionalPrompt: false },
  codex: { model: true, efforts: CODEX_EFFORTS, ultracode: false, positionalPrompt: true },
  "dsh-tui": { model: false, efforts: DSH_EFFORTS, ultracode: false, positionalPrompt: false },
};

const MODEL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  claude: ["sonnet", "opus", "haiku"],
};

export function modelSuggestions(kind: string): readonly string[] {
  return Object.hasOwn(MODEL_ALIASES, kind) ? MODEL_ALIASES[kind]! : [];
}

/** What `kind`'s launch takes; a shell ("") and every agent without a verified flag take nothing. */
export function launchCapabilities(kind: string): LaunchCapabilities {
  return Object.hasOwn(CAPABILITIES, kind) ? CAPABILITIES[kind]! : NO_CAPABILITIES;
}

/**
 * The dialog's choices for a launch; an empty model or effort, and Ultracode off, leave it to the agent's
 * own configuration.
 */
export interface LaunchChoices {
  model?: string;
  effort?: string;
  ultracode?: boolean;
  prompt?: string;
}

/**
 * Why `choices` cannot start `kind`: the first choice the launch does not take, or null when it takes them
 * all. The dialog disables what this would refuse; the launch itself refuses it again.
 */
export function launchChoiceFault(kind: string, choices: LaunchChoices): "model" | "effort" | "ultracode" | "prompt" | null {
  const can = launchCapabilities(kind);
  const model = choices.model?.trim() ?? "";
  if (model !== "" && (!can.model || !MODEL_NAME.test(model))) return "model";
  if (choices.effort && !can.efforts.includes(choices.effort)) return "effort";
  if (choices.ultracode && !can.ultracode) return "ultracode";
  if ((choices.prompt?.trim() ?? "") !== "" && kind === "") return "prompt";
  return null;
}

/**
 * Where a first prompt for `kind` goes: `positional` as the agent's own argument after `--`, `pending` as
 * the first message queued for the agent's first ready turn; null for no prompt.
 */
export function firstPromptDelivery(kind: string, prompt: string | undefined): "positional" | "pending" | null {
  const text = prompt?.trim() ?? "";
  if (text === "" || kind === "") return null;
  return launchCapabilities(kind).positionalPrompt && hasNoControlCharacters(text) ? "positional" : "pending";
}

/** Settings > Agents: the model and effort a new Claude Code or Codex starts on; "" leaves each to the agent's own configuration. */
export interface LaunchDefaultSettings {
  claudeLaunchModel: string;
  claudeLaunchEffort: string;
  codexLaunchModel: string;
  codexLaunchEffort: string;
}

export function launchDefaults(kind: string, settings: LaunchDefaultSettings): { model: string; effort: string } {
  const set = kind === "claude" ? { model: settings.claudeLaunchModel, effort: settings.claudeLaunchEffort }
    : kind === "codex" ? { model: settings.codexLaunchModel, effort: settings.codexLaunchEffort } : null;
  if (set === null) return { model: "", effort: "" };
  const model = set.model.trim();
  return {
    model: launchChoiceFault(kind, { model }) === null ? model : "",
    effort: launchChoiceFault(kind, { effort: set.effort }) === null ? set.effort : "",
  };
}

export function modelDraftAfterSync(kind: string, draft: string, model: string): string {
  return draft.trim() === model || launchChoiceFault(kind, { model: draft }) === "model" ? draft : model;
}

/** The arguments a new agent of `kind` starts with; undefined when there are none to add. */
export function launchArgs(kind: string, modes: { claudeLaunchMode: ClaudeLaunchMode; codexLaunchMode: CodexLaunchMode }, choices: LaunchChoices = {}): string[] | undefined {
  const args: string[] = [];
  if (kind === "claude" && modes.claudeLaunchMode !== "default") args.push("--permission-mode", modes.claudeLaunchMode);
  if (kind === "codex" && modes.codexLaunchMode !== "default") args.push(...CODEX_ARGS[modes.codexLaunchMode]);
  const can = launchCapabilities(kind);
  const model = choices.model?.trim() ?? "";
  if (model !== "" && can.model && MODEL_NAME.test(model)) args.push("--model", model);
  if (choices.effort && can.efforts.includes(choices.effort)) {
    args.push(...(kind === "codex" ? ["-c", `model_reasoning_effort=${choices.effort}`] : ["--effort", choices.effort]));
  }
  if (choices.ultracode && can.ultracode) args.push("--settings", CLAUDE_ULTRACODE_SETTINGS);
  if (firstPromptDelivery(kind, choices.prompt) === "positional") args.push("--", choices.prompt!.trim());
  return args.length === 0 ? undefined : args;
}

/** The `agent` of a create request: the kind and the arguments its mode and choices add; null for a plain shell. */
export function launchAgent(kind: string, modes: { claudeLaunchMode: ClaudeLaunchMode; codexLaunchMode: CodexLaunchMode }, choices: LaunchChoices = {}): { kind: string; args?: string[] } | null {
  if (!kind) return null;
  const args = launchArgs(kind, modes, choices);
  return args === undefined ? { kind } : { kind, args };
}

export interface AgentLaunchSpec {
  agent: { kind: string; args?: string[] } | null;
  prompt: { text: string; via: "positional" | "pending" } | null;
}

/** Builds the launch payload (`agent` + `prompt`) from the server's shared preferences, matching the New workspace/tab dialog's defaults. */
export function launchSpecFromPreferences(kind: string, settings: SharedPreferences["settings"] | undefined, prompt?: string): AgentLaunchSpec {
  const claudeLaunchMode = CLAUDE_LAUNCH_MODES.includes(settings?.claudeLaunchMode as ClaudeLaunchMode)
    ? (settings!.claudeLaunchMode as ClaudeLaunchMode)
    : "default";
  const codexLaunchMode = CODEX_LAUNCH_MODES.includes(settings?.codexLaunchMode as CodexLaunchMode)
    ? (settings!.codexLaunchMode as CodexLaunchMode)
    : "default";
  const defaults = launchDefaults(kind, {
    claudeLaunchModel: typeof settings?.claudeLaunchModel === "string" ? settings.claudeLaunchModel : "",
    claudeLaunchEffort: typeof settings?.claudeLaunchEffort === "string" ? settings.claudeLaunchEffort : "",
    codexLaunchModel: typeof settings?.codexLaunchModel === "string" ? settings.codexLaunchModel : "",
    codexLaunchEffort: typeof settings?.codexLaunchEffort === "string" ? settings.codexLaunchEffort : "",
  });
  const via = firstPromptDelivery(kind, prompt);
  const text = prompt?.trim() ?? "";
  return {
    agent: launchAgent(kind, { claudeLaunchMode, codexLaunchMode }, {
      model: defaults.model,
      effort: defaults.effort,
      prompt: via === "positional" ? text : "",
    }),
    prompt: via === null ? null : { text, via },
  };
}
