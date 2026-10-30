import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SKILL_SEARCH_ENTRY_LIMIT } from "../../src/constants.js";
import { withTypedSkill } from "../../src/turn-enrichment.js";
import { typedCommandOf, typedSkillName } from "../../src/utils/skills.js";

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

function isCaseInsensitiveFilesystem(): boolean {
  mkdirSync(join(dir, "Probe"));
  try {
    mkdirSync(join(dir, "probe"));
    return false;
  } catch {
    return true;
  }
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
  it("takes the name and the folders the prompt was typed in", () => {
    expect(typedCommandOf("/deploy to staging", ["/a", "/b"])).toEqual({
      name: "deploy",
      workspaceRoots: ["/a", "/b"],
    });
  });

  it("drops folders that are not text instead of failing", () => {
    expect(typedCommandOf("/deploy", [null, "/a", 5])).toEqual({
      name: "deploy",
      workspaceRoots: ["/a"],
    });
    expect(typedCommandOf("/deploy", undefined)).toEqual({ name: "deploy", workspaceRoots: [] });
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

describe("typedSkillName", () => {
  it.each<[string, string[], string]>([
    ["a project .cursor skill", ["project", ".cursor", "skills", "deploy"], "deploy"],
    ["a project .agents skill", ["project", ".agents", "skills", "deploy"], "deploy"],
    ["a project .claude skill", ["project", ".claude", "skills", "deploy"], "deploy"],
    ["a project .codex skill", ["project", ".codex", "skills", "deploy"], "deploy"],
    ["a home .cursor skill", ["home", ".cursor", "skills", "deploy"], "deploy"],
    ["a built-in skill", ["home", ".cursor", "skills-cursor", "create-rule"], "create-rule"],
    ["a group folder", ["home", ".cursor", "skills", "group", "deploy"], "deploy"],
    [
      "a synced skill",
      ["home", ".agents", "skills", "synced", "aaa_bbb", "explainer"],
      "explainer",
    ],
  ])("finds %s", (_case, segments, name) => {
    addSkill(dir, ...segments);
    expect(resolve(name)).toBe(name);
  });

  it("returns the folder's real name when the typed case differs", () => {
    addSkill(dir, "project", ".cursor", "skills", "deploy");
    expect(resolve("Deploy")).toBe("deploy");
  });

  it("prefers the exact name over a different-case folder", (ctx) => {
    if (isCaseInsensitiveFilesystem()) ctx.skip();
    addSkill(dir, "project", ".cursor", "skills", "Deploy");
    addSkill(dir, "project", ".cursor", "skills", "deploy");
    expect(resolve("deploy")).toBe("deploy");
  });

  it("follows a symlinked skill folder", () => {
    addSkill(dir, "elsewhere", "deploy");
    mkdirSync(join(project, ".cursor", "skills"), { recursive: true });
    symlinkSync(join(dir, "elsewhere", "deploy"), join(project, ".cursor", "skills", "deploy"));
    expect(resolve("deploy")).toBe("deploy");
  });

  it("asks the workspace before the home folder", () => {
    addSkill(dir, "project", ".cursor", "skills", "Deploy");
    addSkill(dir, "home", ".cursor", "skills", "deploy");
    expect(resolve("deploy")).toBe("Deploy");
  });

  it("checks every workspace root, not only the first", () => {
    const second = join(dir, "second");
    mkdirSync(second);
    addSkill(dir, "second", ".cursor", "skills", "deploy");
    expect(resolve("deploy", [project, second])).toBe("deploy");
  });

  it("stops looking three folders down", () => {
    addSkill(dir, "project", ".cursor", "skills", "a", "b", "c", "deep");
    addSkill(dir, "project", ".cursor", "skills", "a", "b", "shallow");
    expect(resolve("shallow")).toBe("shallow");
    expect(resolve("deep")).toBeUndefined();
  });

  it("stops after the entry limit across the whole walk, not per folder", () => {
    const skills = join(project, ".cursor", "skills");
    for (let i = 0; i < SKILL_SEARCH_ENTRY_LIMIT * 0.75; i++) {
      mkdirSync(join(skills, `f${String(i).padStart(5, "0")}`), { recursive: true });
    }
    for (let i = 0; i < SKILL_SEARCH_ENTRY_LIMIT * 0.5; i++) {
      mkdirSync(join(skills, "f00000", `g${String(i).padStart(5, "0")}`), { recursive: true });
    }
    addSkill(skills, "f00000", "zzz");
    addSkill(skills, "f00001");
    expect(resolve("f00001")).toBe("f00001");
    expect(resolve("zzz")).toBeUndefined();
  });

  it("does not look inside another skill, the same rule a read follows", () => {
    addSkill(dir, "project", ".cursor", "skills", "outer");
    addSkill(dir, "project", ".cursor", "skills", "outer", "inner");
    expect(resolve("outer")).toBe("outer");
    expect(resolve("inner")).toBeUndefined();
  });

  it("ignores a command with no skill of that name, like a built-in /add-plugin", () => {
    addSkill(dir, "home", ".cursor", "skills", "deploy");
    expect(resolve("add-plugin")).toBeUndefined();
  });

  it("ignores a skill folder with no SKILL.md in it", () => {
    mkdirSync(join(project, ".cursor", "skills", "empty"), { recursive: true });
    expect(resolve("empty")).toBeUndefined();
  });

  it("gives nothing, rather than failing, when a folder is not text", () => {
    expect(
      typedSkillName({ name: "deploy", workspaceRoots: [null as unknown as string] }, home),
    ).toBeUndefined();
  });
});

describe("withTypedSkill", () => {
  const buffer = (name: string) => ({
    generation_id: "generation",
    startMs: 0,
    tools: [],
    thoughts: [],
    subagents: [],
    typedCommand: { name, workspaceRoots: [project] },
  });

  it("looks in the home folder once per turn, not once per upload job", () => {
    vi.stubEnv("HOME", home);
    addSkill(dir, "home", ".cursor", "skills", "once");
    expect(withTypedSkill(buffer("once")).typedSkill).toBe("once");
    rmSync(join(home, ".cursor"), { recursive: true });
    expect(withTypedSkill(buffer("once")).typedSkill).toBe("once");
    vi.unstubAllEnvs();
  });
});
