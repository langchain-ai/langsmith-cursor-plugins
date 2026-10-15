import { LS_INTEGRATION_VERSION } from "./config.js";
import {
  LS_AGENT_PURPOSE,
  LS_AGENT_RUNTIME,
  LS_INTEGRATION,
  LS_TRACE_SCHEMA_VERSION,
  PATH_SEPARATOR,
  SKILL_READ_TOOLS,
} from "./constants.js";
import type { CodingAgentMetadataOptions } from "./models/metadata.js";

const TRUSTED_METADATA = Symbol("cursor.trustedMetadata");
export function trustedCodingAgentMetadata(
  metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return metadata
    ? (metadata as Record<symbol, Record<string, unknown>>)[TRUSTED_METADATA]
    : undefined;
}

/**
 * coding-agent-v1 trace metadata for the Cursor integration. See
 * ../../coding-agent-v1/validator.json for the contract.
 */

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Build the coding-agent-v1 metadata for one run. Merge order (later wins):
 * identity → dynamic → runSpecific → base.
 */
export function codingAgentMetadata(opts: CodingAgentMetadataOptions): Record<string, unknown> {
  const {
    agentType,
    threadId,
    base,
    turnId,
    turnNumber,
    runtimeVersion,
    approvalPolicy,
    subagentId,
    subagentType,
    clearSubagent,
    toolName,
    runName,
    skillName,
    runSpecific,
  } = opts;

  const meta: Record<string, unknown> = {
    // Identity & grouping — always present.
    ls_agent_purpose: LS_AGENT_PURPOSE,
    ls_agent_type: agentType,
    ls_integration: LS_INTEGRATION,
    ls_agent_runtime: LS_AGENT_RUNTIME,
    ls_trace_schema_version: LS_TRACE_SCHEMA_VERSION,
    thread_id: threadId,
  };

  // Turn — emit whichever is known (at least one required where turns exist).
  if (turnId) meta.turn_id = turnId;
  if (typeof turnNumber === "number") meta.turn_number = turnNumber;

  // Runtime (Cursor) version where known. Integration version lives in `base`.
  if (runtimeVersion) meta.ls_agent_runtime_version = runtimeVersion;

  // Approval policy — root + interrupted turns only.
  if (approvalPolicy) meta.approval_policy = approvalPolicy;

  // Subagent identity (subagent runs only).
  if (subagentId) meta.ls_subagent_id = subagentId;
  if (subagentType) meta.ls_subagent_type = subagentType;
  // Clear inherited subagent keys on child runs; undefined is dropped on serialize.
  if (clearSubagent) {
    meta.ls_subagent_id = undefined;
    meta.ls_subagent_type = undefined;
  }

  // Tool runs: ls_tool_name only when the native name differs from the run name.
  if (toolName && runName && toolName !== runName) meta.ls_tool_name = toolName;

  // LangSmith groups runs on this key to count skill invocations.
  if (skillName) meta.ls_skill_name = skillName;

  const result = { ...meta, ...runSpecific, ...base };
  // Never trust custom base collisions, including token counts or structural IDs.
  Object.defineProperty(result, TRUSTED_METADATA, {
    value: {
      ...meta,
      ...runSpecific,
      ...(toolName ? { ls_tool_name: toolName } : {}),
      ...(LS_INTEGRATION_VERSION ? { ls_integration_version: LS_INTEGRATION_VERSION } : {}),
    },
  });
  return result;
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
