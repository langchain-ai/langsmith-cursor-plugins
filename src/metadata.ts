import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildCodingAgentMetadata,
  type CodingAgentMetadataOptions,
} from "@langchain/plugins-base/metadata";
import { LS_INTEGRATION_VERSION } from "./config.js";
import {
  LS_INTEGRATION,
  PATH_SEPARATOR,
  SHELL_CAT_PATH,
  SKILL_FOLDERS,
  SKILL_READ_TOOLS,
  SYNCED_SKILLS_FOLDER,
  TYPED_SKILL_ROOT_DIRS,
} from "./constants.js";
import type { CursorMetadataOptions } from "./models/metadata.js";

export function withIntegration(opts: CursorMetadataOptions): CodingAgentMetadataOptions {
  return { ...opts, integration: LS_INTEGRATION, integrationVersion: LS_INTEGRATION_VERSION };
}

export function codingAgentMetadata(opts: CursorMetadataOptions): Record<string, unknown> {
  return buildCodingAgentMetadata(withIntegration(opts));
}

// ─── Skill detection ──────────────────────────────────────────────────────────

/** A heuristic: Cursor has no Skill tool, so a skill read looks like any other read. */
export function skillNameFromTool(toolName: string, toolInput: unknown): string | undefined {
  if (!SKILL_READ_TOOLS.has(toolName)) return undefined;
  // Older captures use `file_path`.
  const input = toolInput as
    | { path?: unknown; file_path?: unknown; command?: unknown }
    | null
    | undefined;
  const command = typeof input?.command === "string" ? input.command : "";
  const filePath = input?.path ?? input?.file_path ?? command.match(SHELL_CAT_PATH)?.[1];
  if (typeof filePath !== "string") return undefined;

  // Not a regex: any path regex backtracks quadratically here (CodeQL `js/polynomial-redos`).
  const segments = filePath.split(PATH_SEPARATOR);
  const file = segments.pop();
  const name = segments.pop();
  // A leading dot would let "." or ".." stand in for the skill name.
  if (file !== "SKILL.md" || !name || name.startsWith(".")) return undefined;
  const folder = segments.at(-2) === SYNCED_SKILLS_FOLDER ? segments.at(-3) : segments.at(-1);
  return SKILL_FOLDERS.has(folder ?? "") ? name : undefined;
}

export function typedSkillName(
  name: string | undefined,
  workspaceRoot: unknown,
): string | undefined {
  if (!name) return undefined;
  const home = homedir();
  const roots = typeof workspaceRoot === "string" ? [workspaceRoot, home] : [home];
  const paths = roots.flatMap((root) =>
    TYPED_SKILL_ROOT_DIRS.map((dir) => join(root, dir, "skills", name, "SKILL.md")),
  );
  paths.push(join(home, ".cursor", "skills-cursor", name, "SKILL.md"));
  return paths.some(existsSync) ? name : undefined;
}
