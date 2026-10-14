export type LSAgentType = "root" | "subagent" | "middleware" | "compaction";

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

  /** Skill this run represents, set on the `Skill` run only. */
  skillName?: string;

  /** Run-type-specific keys (ls_provider, ls_model_name, usage_metadata, …). */
  runSpecific?: Record<string, unknown>;
}
