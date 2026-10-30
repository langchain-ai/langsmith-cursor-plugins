import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { typedSkillName } from "../../src/utils/skills.js";

let dir: string;
let home: string;
let project: string;

function addSkill(...segments: string[]): void {
  const file = join(...segments, "SKILL.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "---\nname: x\n---\n");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cursor-typed-skill-"));
  home = join(dir, "home");
  project = join(dir, "project");
  mkdirSync(home);
  mkdirSync(project);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("typedSkillName", () => {
  it.each<[string, string[], string]>([
    ["a project .cursor skill", ["project", ".cursor", "skills", "deploy"], "deploy"],
    ["a project .agents skill", ["project", ".agents", "skills", "deploy"], "deploy"],
    ["a project .claude skill", ["project", ".claude", "skills", "deploy"], "deploy"],
    ["a project .codex skill", ["project", ".codex", "skills", "deploy"], "deploy"],
    ["a home .cursor skill", ["home", ".cursor", "skills", "deploy"], "deploy"],
    ["a home .agents skill", ["home", ".agents", "skills", "deploy"], "deploy"],
    ["a home .claude skill", ["home", ".claude", "skills", "deploy"], "deploy"],
    ["a home .codex skill", ["home", ".codex", "skills", "deploy"], "deploy"],
    ["a built-in skill", ["home", ".cursor", "skills-cursor", "create-rule"], "create-rule"],
    [
      "a synced skill",
      ["home", ".agents", "skills", "synced", "aaa_bbb", "explainer"],
      "explainer",
    ],
  ])("finds %s", (_case, segments, name) => {
    addSkill(dir, ...segments);
    expect(typedSkillName(`/${name} do it`, [project], home)).toBe(name);
  });

  it("ignores a command with no skill of that name, like a built-in /add-plugin", () => {
    addSkill(dir, "home", ".cursor", "skills", "deploy");
    expect(typedSkillName("/add-plugin https://github.com/x/y", [project], home)).toBeUndefined();
  });

  it("ignores a skill folder with no SKILL.md in it", () => {
    mkdirSync(join(project, ".cursor", "skills", "empty"), { recursive: true });
    expect(typedSkillName("/empty", [project], home)).toBeUndefined();
  });

  it.each([
    ["a slash that is not first", "please run /deploy"],
    ["a path", "/deploy/now"],
    ["a traversal", "/../deploy"],
    ["plain text", "deploy"],
  ])("ignores %s", (_case, prompt) => {
    addSkill(dir, "project", ".cursor", "skills", "deploy");
    expect(typedSkillName(prompt, [project], home)).toBeUndefined();
  });

  it("matches a command followed by a newline and nothing else", () => {
    addSkill(dir, "project", ".cursor", "skills", "deploy");
    expect(typedSkillName("/deploy\nwith details", [project], home)).toBe("deploy");
    expect(typedSkillName("/deploy", [project], home)).toBe("deploy");
  });
});
