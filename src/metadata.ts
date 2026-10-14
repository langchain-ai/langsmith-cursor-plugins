import { buildCodingAgentMetadata } from "@langchain/plugins-base/metadata";
import { LS_INTEGRATION_VERSION } from "./config.js";
import { LS_INTEGRATION, PATH_SEPARATOR, SKILL_READ_TOOLS } from "./constants.js";
import type { CursorMetadataOptions } from "./models/metadata.js";

export function codingAgentMetadata(opts: CursorMetadataOptions): Record<string, unknown> {
  return buildCodingAgentMetadata({
    ...opts,
    integration: LS_INTEGRATION,
    integrationVersion: LS_INTEGRATION_VERSION,
  });
}

// ─── Skill detection ──────────────────────────────────────────────────────────

/** A heuristic: Cursor has no Skill tool, so a skill read looks like any other read. */
export function skillNameFromTool(toolName: string, toolInput: unknown): string | undefined {
  if (!SKILL_READ_TOOLS.has(toolName)) return undefined;
  // Older captures use `file_path`.
  const input = toolInput as { path?: unknown; file_path?: unknown } | null | undefined;
  const filePath = input?.path ?? input?.file_path;
  if (typeof filePath !== "string") return undefined;

  // Not a regex: any path regex backtracks quadratically here (CodeQL `js/polynomial-redos`).
  const segments = filePath.split(PATH_SEPARATOR);
  const file = segments.pop();
  const name = segments.pop();
  // A leading dot would let "." or ".." stand in for the skill name.
  if (file !== "SKILL.md" || !name || name.startsWith(".")) return undefined;
  // `segments` now holds only the directories above the skill.
  return segments.includes("skills") ? name : undefined;
}
