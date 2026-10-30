import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { handlePromptSubmit } from "../src/prompt-control.js";
import { withTypedSkill } from "../src/turn-enrichment.js";
import { loadState } from "./utils/state.js";
import type { TurnBuffer } from "../src/models/types.js";

let dir: string;
let home: string;
let workspace: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cursor-typed-prompt-"));
  home = join(dir, "home");
  workspace = join(dir, "workspace");
  mkdirSync(home);
  mkdirSync(workspace);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("TRACE_TO_LANGSMITH", "true");
  vi.stubEnv("LANGSMITH_API_KEY", "test");
  vi.stubEnv("LANGSMITH_CURSOR_STATE_FILE", join(dir, "state.json"));
  vi.stubEnv("LANGSMITH_CURSOR_PRIVACY_FILE", join(dir, "privacy.json"));
  vi.stubEnv("LANGSMITH_CURSOR_LOG_FILE", join(dir, "hook.log"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function addSkill(root: string, name: string): void {
  const file = join(root, ".cursor", "skills", name, "SKILL.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "x");
}

async function submit(prompt: string, roots: unknown = [workspace]) {
  const reply = await handlePromptSubmit({
    hook_event_name: "beforeSubmitPrompt",
    conversation_id: "thread",
    generation_id: "generation",
    model: "default",
    prompt,
    workspace_roots: roots as string[],
  });
  return { reply, turn: loadState(join(dir, "state.json")).thread.turns.generation };
}

const bufferTyping = (name: string, roots: string[]): TurnBuffer => ({
  generation_id: "generation",
  startMs: 0,
  tools: [],
  thoughts: [],
  subagents: [],
  typedCommand: { name, workspaceRoots: roots },
});

it("saves the typed name and folders without looking at the disk", async () => {
  const { turn } = await submit("/anything go");
  expect(turn.typedCommand).toEqual({ name: "anything", workspaceRoots: [workspace] });
});

it("keeps the turn when a workspace folder is not text", async () => {
  const { reply, turn } = await submit("/deploy", [null]);
  expect(reply.continue).toBe(true);
  expect(turn.typedCommand).toEqual({ name: "deploy", workspaceRoots: [] });
});

it("resolves a skill that lives only in the workspace folder at upload", () => {
  addSkill(workspace, "project-only");
  expect(withTypedSkill(bufferTyping("project-only", [workspace])).typedSkill).toBe("project-only");
});

it("resolves a skill that lives only in the home folder at upload", () => {
  addSkill(home, "home-only");
  expect(withTypedSkill(bufferTyping("home-only", [workspace])).typedSkill).toBe("home-only");
});

it("leaves a command with no skill behind it unresolved", () => {
  addSkill(home, "deploy");
  expect(withTypedSkill(bufferTyping("add-plugin", [workspace])).typedSkill).toBeUndefined();
});
