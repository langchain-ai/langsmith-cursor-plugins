import { LS_INTEGRATION_VERSION } from "./config.js";

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

// ─── Frozen literals (identity block) ────────────────────────────────────────

export const LS_AGENT_PURPOSE = "coding";
export type LSAgentType = "root" | "subagent" | "middleware" | "compaction";
export const LS_INTEGRATION = "cursor";
export const LS_AGENT_RUNTIME = "Cursor";
export const LS_TRACE_SCHEMA_VERSION = "coding-agent-v1";

// ─── Helper input ─────────────────────────────────────────────────────────────

export interface CodingAgentMetadataOptions {
  /** Role of the run within the coding-agent trace. Required on every run. */
  agentType: LSAgentType;

  /** Stable conversation id → `thread_id`. Required on every run. */
  threadId: string;

  /** Static base metadata (repo/git/cwd/user/version). Spread LAST so user keys win. */
  base?: Record<string, unknown>;

  /** Per-turn id (`turn_id`) — Cursor `generation_id`. */
  turnId?: string;
  /** 1-based turn index (`turn_number`). */
  turnNumber?: number;
  /** Cursor runtime version (`ls_agent_runtime_version`) — hook `cursor_version`. */
  runtimeVersion?: string;

  /** Permission mode for the turn (`approval_policy`). Root + interrupted only. */
  approvalPolicy?: string;

  /** Subagent identity (subagent runs only) → `ls_subagent_id` / `ls_subagent_type`. */
  subagentId?: string;
  subagentType?: string;
  /** On a subagent's child runs, clears the subagent-only keys so they don't leak down. */
  clearSubagent?: boolean;

  /** Native tool name (tool runs). Emits `ls_tool_name` only when it differs from `runName`. */
  toolName?: string;
  /** Run `name`, used to decide whether `ls_tool_name` is needed. */
  runName?: string;

  /** Skill invoked on this tool run (`ls_skill_name`). See `skillNameFromTool`. */
  skillName?: string;

  /** Run-type-specific keys (ls_provider, ls_model_name, usage_metadata, …). */
  runSpecific?: Record<string, unknown>;
}

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

  // Skill usage, queryable via RunQueryStats (group_by metadata path=ls_skill_name).
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

/** Cursor's file-read tools. `read_file_v2` is current, `Read` the pre-3.20 spelling. */
const READ_TOOLS = new Set(["read_file_v2", "Read"]);

/** Rejects `.`, `..` and dotfiles, so a traversal segment is never read as a skill name. */
const SKILL_DIR = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Skill invoked by a tool call, taken from a `skills/…/<name>/SKILL.md` read.
 *
 * Cursor marks invocations nowhere, so this is a heuristic: reading a SKILL.md
 * is indistinguishable from opening that file for any other reason. Read tools
 * only — Cursor locates a skill with several `glob_file_search` calls whose args
 * also name SKILL.md, which would turn one invocation into many detections.
 */
export function skillNameFromTool(toolName: string, toolInput: unknown): string | undefined {
  if (!READ_TOOLS.has(toolName)) return undefined;
  // `path` is current; `file_path` is the pre-3.20 key.
  const input = toolInput as { path?: unknown; file_path?: unknown } | null | undefined;
  const filePath = input?.path ?? input?.file_path;
  if (typeof filePath !== "string") return undefined;

  // Split rather than match one path regex: such a regex needs an intermediate
  // segment that can span separators, and backtracks quadratically on a hostile
  // path (CodeQL `js/polynomial-redos`). Narrowing the segment stays quadratic.
  const segments = filePath.split(/[/\\]/);
  if (segments.pop() !== "SKILL.md") return undefined;
  const name = segments.pop() ?? "";
  return SKILL_DIR.test(name) && segments.includes("skills") ? name : undefined;
}
