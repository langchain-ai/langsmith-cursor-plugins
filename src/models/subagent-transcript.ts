import type { SubagentToolCall } from "./normalize.js";

export interface ResolvedSubagentTranscript {
  /** Basename of the matched transcript file (= the subagent's conversation_id). */
  childConversationId: string;
  toolCalls: SubagentToolCall[];
  resultText?: string;
}
