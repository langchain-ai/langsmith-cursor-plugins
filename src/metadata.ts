import {
  buildCodingAgentMetadata,
  type CodingAgentMetadataOptions,
} from "@langchain/plugins-base/metadata";
import { LS_INTEGRATION_VERSION } from "./config.js";
import {
  LS_INTEGRATION,
  PATH_SEPARATOR,
  SKILL_DIRECTORY_NAME,
  SKILL_DIRECTORY_NAMES,
  SKILL_FILE_NAME,
  SKILL_READ_TOOLS,
  SKILL_SHELL_TOOLS,
  SYNCED_SKILLS_DIRECTORY_NAME,
} from "./constants.js";
import { skillPathFromShellCommand } from "./utils/skills.js";
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
  // Older captures use `file_path`.
  const input = toolInput as
    | { path?: unknown; file_path?: unknown; command?: unknown }
    | null
    | undefined;
  if (SKILL_READ_TOOLS.has(toolName)) return skillNameFromPath(input?.path ?? input?.file_path);
  if (SKILL_SHELL_TOOLS.has(toolName) && typeof input?.command === "string")
    return skillNameFromPath(skillPathFromShellCommand(input.command));
  return undefined;
}

function skillNameFromPath(filePath: unknown): string | undefined {
  if (typeof filePath !== "string") return undefined;

  // Not a regex: any path regex backtracks quadratically here (CodeQL `js/polynomial-redos`).
  const segments = filePath.split(PATH_SEPARATOR);
  const file = segments.pop();
  const name = segments.pop();
  // A leading dot would let "." or ".." stand in for the skill name.
  if (file !== SKILL_FILE_NAME || !name || name.startsWith(".")) return undefined;
  return isSkillsFolder(segments) ? name : undefined;
}

function isSkillsFolder(segments: string[]): boolean {
  const parent = segments.at(-1);
  if (parent !== undefined && SKILL_DIRECTORY_NAMES.has(parent)) return true;
  return (
    segments.at(-2) === SYNCED_SKILLS_DIRECTORY_NAME && segments.at(-3) === SKILL_DIRECTORY_NAME
  );
}
