import type { SubagentToolCall } from "./normalize.js";
import type { SweepClaim, TracingState, TurnBuffer } from "./types.js";

/** Data recovered from the on-disk subagent transcript (resolved in the hook). */
export interface ResolvedSubagent {
  /** The subagent's own conversation_id (= transcript filename). */
  childConversationId?: string;
  /** Tool calls from the transcript (inputs only) — fallback when no child buffer. */
  toolCalls?: SubagentToolCall[];
  resultText?: string;
}

export interface StopResult {
  state: TracingState;
  /** The finalized turn to trace, or undefined if there was no buffered turn. */
  buffer?: TurnBuffer;
  turnNum: number;
}

export interface SweepResult {
  state: TracingState;
  claims: SweepClaim[];
}

export interface ConversationSweep {
  claims: SweepClaim[];
  changed: boolean;
}
