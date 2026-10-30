import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { handlePromptSubmit } from "../src/prompt-control.js";
import { loadState } from "./utils/state.js";

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

async function typedSkillOf(prompt: string): Promise<string | undefined> {
  await handlePromptSubmit({
    hook_event_name: "beforeSubmitPrompt",
    conversation_id: "thread",
    generation_id: "generation",
    model: "default",
    prompt,
    workspace_roots: [workspace],
  });
  return loadState(join(dir, "state.json")).thread.turns.generation.typedSkill;
}

it("finds a skill that lives only in the workspace folder", async () => {
  addSkill(workspace, "project-only");
  expect(await typedSkillOf("/project-only go")).toBe("project-only");
});

it("finds a skill that lives only in the home folder", async () => {
  addSkill(home, "home-only");
  expect(await typedSkillOf("/home-only go")).toBe("home-only");
});

it("records nothing for a command with no skill behind it", async () => {
  addSkill(home, "deploy");
  expect(await typedSkillOf("/add-plugin https://github.com/x/y")).toBeUndefined();
});
