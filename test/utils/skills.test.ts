import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pickName, typedCommandOf, typedSkillName } from "../../src/utils/skills.js";

let dir: string;
let home: string;
let project: string;

function addSkill(...segments: string[]): void {
  const file = join(...segments, "SKILL.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "---\nname: x\n---\n");
}

function resolve(name: string, roots: string[] = [project]): string | undefined {
  return typedSkillName({ name, workspaceRoots: roots }, home);
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

describe("typedCommandOf", () => {
  it.each<[string, unknown, unknown, unknown]>([
    ["takes the name and the folders", "/deploy to staging", ["/a", "/b"], ["/a", "/b"]],
    ["drops folders that are not text", "/deploy", [null, "/a", 5], ["/a"]],
    ["copes with no folders at all", "/deploy", undefined, []],
    ["takes the name up to a newline", "/deploy\nmore", [], []],
  ])("%s", (_case, prompt, roots, expected) => {
    expect(typedCommandOf(prompt, roots)).toEqual({ name: "deploy", workspaceRoots: expected });
  });

  it.each([
    ["a slash that is not first", "please run /deploy"],
    ["a path", "/deploy/now"],
    ["a traversal", "/../deploy"],
    ["plain text", "deploy"],
    ["no text", 42],
  ])("ignores %s", (_case, prompt) => {
    expect(typedCommandOf(prompt, [])).toBeUndefined();
  });
});

describe("pickName", () => {
  it("takes the exact name wherever it sits, then the smallest name", () => {
    expect(pickName(["Deploy", "deploy"], "deploy")).toBe("deploy");
    expect(pickName(["deploy", "Deploy"], "Deploy")).toBe("Deploy");
    expect(pickName(["deploy", "Deploy", "DEPLOY"], "dePloy")).toBe("DEPLOY");
  });
});

describe("typedSkillName", () => {
  it.each<[string, string[], string]>([
    ["a project .cursor skill", ["project", ".cursor", "skills", "deploy"], "deploy"],
    ["a project .agents skill", ["project", ".agents", "skills", "deploy"], "deploy"],
    ["a project .claude skill", ["project", ".claude", "skills", "deploy"], "deploy"],
    ["a project .codex skill", ["project", ".codex", "skills", "deploy"], "deploy"],
    ["a built-in skill", ["home", ".cursor", "skills-cursor", "create-rule"], "create-rule"],
    ["a synced skill", ["home", ".agents", "skills", "synced", "id", "explainer"], "explainer"],
  ])("finds %s", (_case, segments, name) => {
    addSkill(dir, ...segments);
    expect(resolve(name)).toBe(name);
  });

  it("follows a symlinked skill folder", () => {
    addSkill(dir, "elsewhere", "deploy");
    mkdirSync(join(project, ".cursor", "skills"), { recursive: true });
    symlinkSync(join(dir, "elsewhere", "deploy"), join(project, ".cursor", "skills", "deploy"));
    expect(resolve("deploy")).toBe("deploy");
  });

  it("finds differently cased names in groups and prefers an exact match in any root", () => {
    const second = join(dir, "second");
    addSkill(dir, "project", ".cursor", "skills", "grp", "Foo");
    addSkill(dir, "home", ".agents", "skills", "synced", "id1", "Bar");
    addSkill(dir, "project", ".cursor", "skills", "Deploy");
    addSkill(dir, "project", ".agents", "skills", "grp", "DEPLOY");
    addSkill(dir, "second", ".cursor", "skills", "deploy");
    const both = [project, second];
    expect([resolve("foo"), resolve("BAR")]).toEqual(["Foo", "Bar"]);
    expect(resolve("deploy", both)).toBe("deploy");
    expect(resolve("dePloy", both)).toBe("DEPLOY");
  });

  it("searches one group level and no deeper", () => {
    addSkill(dir, "project", ".cursor", "skills", "a", "shallow");
    addSkill(dir, "project", ".cursor", "skills", "a", "b", "deep");
    expect(resolve("shallow")).toBe("shallow");
    expect(resolve("deep")).toBeUndefined();
  });

  it("does not let a big synced folder hide skills elsewhere", () => {
    const synced = join(home, ".agents", "skills", "synced");
    for (let i = 0; i < 1100; i++) mkdirSync(join(synced, `id${i}`), { recursive: true });
    addSkill(synced, "id1099", "late");
    addSkill(dir, "home", ".cursor", "skills", "mine");
    expect(resolve("late")).toBe("late");
    expect(resolve("mine")).toBe("mine");
  });

  it("does not look inside another skill, the same rule a read follows", () => {
    addSkill(dir, "project", ".cursor", "skills", "outer");
    addSkill(dir, "project", ".cursor", "skills", "outer", "inner");
    expect(resolve("outer")).toBe("outer");
    expect(resolve("inner")).toBeUndefined();
  });

  it("ignores names with no skill behind them and folders with no SKILL.md", () => {
    addSkill(dir, "home", ".cursor", "skills", "deploy");
    mkdirSync(join(project, ".cursor", "skills", "top-empty"), { recursive: true });
    mkdirSync(join(project, ".cursor", "skills", "grp", "group-empty"), { recursive: true });
    addSkill(dir, "project", ".cursor", "skills", "grp", "real");
    for (const name of ["add-plugin", "top-empty", "group-empty"]) {
      expect(resolve(name)).toBeUndefined();
    }
  });

  it("gives nothing, rather than failing, when a folder is not text", () => {
    const roots = [null] as unknown as string[];
    expect(typedSkillName({ name: "deploy", workspaceRoots: roots }, home)).toBeUndefined();
  });
});
