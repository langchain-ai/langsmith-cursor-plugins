/**
 * coding-agent-v1 trace metadata for the Cursor integration. See
 * ../../coding-agent-v1/validator.json for the contract.
 */

// ─── Frozen literals (identity block) ────────────────────────────────────────

export const LS_AGENT_KIND = "coding_agent";
export const LS_INTEGRATION = "cursor";
export const LS_AGENT_RUNTIME = "Cursor";
export const LS_TRACE_SCHEMA_VERSION = "coding-agent-v1";

// ─── Helper input ─────────────────────────────────────────────────────────────

export interface CodingAgentMetadataOptions {
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

  /** Run-type-specific keys (ls_provider, ls_model_name, usage_metadata, …). */
  runSpecific?: Record<string, unknown>;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Build the coding-agent-v1 metadata for one run. Merge order (later wins):
 * identity → dynamic → runSpecific → base.
 */
export function codingAgentMetadata(
  opts: CodingAgentMetadataOptions,
): Record<string, unknown> {
  const {
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
    runSpecific,
  } = opts;

  const meta: Record<string, unknown> = {
    // Identity & grouping — always present.
    ls_agent_kind: LS_AGENT_KIND,
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

  return {
    ...meta,
    ...runSpecific,
    ...base,
  };
}
