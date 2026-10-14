export interface ModelInfo {
  ls_model_name: string;
  ls_provider?: string;
}

/** A tool call recovered from a subagent transcript (inputs only — no output). */
export interface SubagentToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface UsageMetadata {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_token_details: { cache_read: number; cache_creation: number };
}
