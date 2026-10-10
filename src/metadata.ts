import { buildCodingAgentMetadata } from "@langchain/plugins-base/metadata";
import type { CodingAgentMetadataOptions as SharedCodingAgentMetadataOptions } from "@langchain/plugins-base/metadata";
import { LS_INTEGRATION_VERSION } from "./config.js";
import {
  CODING_AGENT_METADATA_OPTIONS,
  CURSOR_INTEGRATION,
  READ_TOOLS,
} from "./constants.js";
import type { CodingAgentMetadataOptions } from "./models/metadata.js";

export type { CodingAgentMetadataOptions, LSAgentType } from "./models/metadata.js";

export function codingAgentMetadata(opts: CodingAgentMetadataOptions): Record<string, unknown> {
  const options: SharedCodingAgentMetadataOptions = {
    ...opts,
    integration: CURSOR_INTEGRATION,
    ...(LS_INTEGRATION_VERSION ? { integrationVersion: LS_INTEGRATION_VERSION } : {}),
  };
  const metadata = buildCodingAgentMetadata(options);
  Object.defineProperty(metadata, CODING_AGENT_METADATA_OPTIONS, {
    value: Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
    enumerable: true,
  });
  return metadata;
}

/** A heuristic: Cursor has no Skill tool, so a skill read looks like any other read. */
export function skillNameFromTool(toolName: string, toolInput: unknown): string | undefined {
  if (!READ_TOOLS.has(toolName)) return undefined;
  // Older captures use `file_path`.
  const input = toolInput as { path?: unknown; file_path?: unknown } | null | undefined;
  const filePath = input?.path ?? input?.file_path;
  if (typeof filePath !== "string") return undefined;

  // Not a regex: any path regex backtracks quadratically here (CodeQL `js/polynomial-redos`).
  const segments = filePath.split(/[/\\]/);
  const file = segments.pop();
  const name = segments.pop();
  // A leading dot would let "." or ".." stand in for the skill name.
  if (file !== "SKILL.md" || !name || name.startsWith(".")) return undefined;
  // `segments` now holds only the directories above the skill.
  return segments.includes("skills") ? name : undefined;
}
