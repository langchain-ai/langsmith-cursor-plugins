/**
 * Types for Cursor hook inputs (stdin JSON) and the on-disk event-buffer state.
 * Field names mirror the real captured payloads.
 */

// ─── Multimodal content ──────────────────────────────────────────────────────

/**
 * A LangChain v1 multimodal content part. `mime_type` is required with `base64`
 * — the shape the LangSmith UI renders inline.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mime_type: string; base64: string }
  | { type: "file"; mime_type: string; base64: string; filename?: string };

// ─── Hook Input Types ───────────────────────────────────────────────────────

/** Fields present on (almost) every Cursor hook payload. */
export interface HookInputBase {
  conversation_id: string;
  /** Changes per user message; identifies a single turn. */
  generation_id: string;
  /** Cursor's model label, e.g. "claude-4.6-sonnet-medium-thinking" or "default" (Auto). */
  model: string;
  /** Equal to conversation_id. */
  session_id?: string;
  hook_event_name: string;
  cursor_version?: string;
  workspace_roots?: string[];
  user_email?: string | null;
  transcript_path?: string | null;
}

export interface BeforeSubmitPromptInput extends HookInputBase {
  hook_event_name: "beforeSubmitPrompt";
  prompt: string;
  /** Always empty in practice — Cursor does not expose attachment bytes to hooks. */
  attachments?: unknown[];
  composer_mode?: string;
}

/** Token usage carried by both afterAgentResponse and stop. */
export interface UsageFields {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export interface AfterAgentResponseInput extends HookInputBase, UsageFields {
  hook_event_name: "afterAgentResponse";
  text: string;
}

export interface AfterAgentThoughtInput extends HookInputBase {
  hook_event_name: "afterAgentThought";
  text: string;
  duration_ms?: number;
}

export interface StopInput extends HookInputBase, UsageFields {
  hook_event_name: "stop";
  status?: string;
  loop_count?: number;
}

export interface PostToolUseInput extends HookInputBase {
  hook_event_name: "postToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  /** A JSON-encoded string (must be parsed). */
  tool_output: string;
  tool_use_id: string;
  duration?: number;
  cwd?: string;
}

export interface PostToolUseFailureInput extends HookInputBase {
  hook_event_name: "postToolUseFailure";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
  error_message: string;
  failure_type?: string;
  duration?: number;
  is_interrupt?: boolean;
  cwd?: string;
}

export interface SubagentStartInput extends HookInputBase {
  hook_event_name: "subagentStart";
  subagent_id: string;
  subagent_type: string;
  task: string;
  parent_conversation_id?: string;
  /** Equals the parent Task tool's tool_use_id — the linking key. */
  tool_call_id?: string;
  subagent_model?: string;
  is_parallel_worker?: boolean;
}

export interface SubagentStopInput extends HookInputBase {
  hook_event_name: "subagentStop";
  subagent_id: string;
  subagent_type: string;
  status?: string;
  task?: string;
  description?: string;
  duration_ms?: number;
  /** Unreliable — observed as 0 even when the subagent made many tool calls. */
  message_count?: number;
  tool_call_count?: number;
  loop_count?: number;
  parent_conversation_id?: string;
  /** Observed null — subagent transcript is not exposed via the hook. */
  agent_transcript_path?: string | null;
}

export interface SessionStartInput extends HookInputBase {
  hook_event_name: "sessionStart";
  is_background_agent?: boolean;
  composer_mode?: string;
}

// ─── Event-buffer state (on-disk) ────────────────────────────────────────────

/** A single tool invocation, buffered between postToolUse and stop. */
export interface ToolEvent {
  tool_use_id: string;
  name: string;
  input: Record<string, unknown>;
  /** Parsed tool_output (postToolUse), if any. */
  output?: unknown;
  /** error_message (postToolUseFailure), if the tool failed. */
  error?: string;
  failure_type?: string;
  duration?: number;
  /** Wall-clock ms when the hook fired (tool end). */
  endMs: number;
}

/** A subagent invocation, rendered as a Task tool run with nested tool children. */
export interface SubagentEvent {
  subagent_id: string;
  subagent_type: string;
  task: string;
  /** Short human-readable label for the task (subagentStop.description). */
  description?: string;
  /** Cursor model label the subagent ran on (subagentStart.subagent_model). */
  model?: string;
  /** True when this subagent is one of several parallel workers. */
  is_parallel_worker?: boolean;
  status?: string;
  duration_ms?: number;
  /** Cursor-reported counts at subagentStop (often 0 — unreliable, surfaced as-is). */
  message_count?: number;
  tool_call_count?: number;
  loop_count?: number;
  /** Wall-clock ms when subagentStart fired. */
  startMs: number;
  /** Wall-clock ms when subagentStop fired. */
  endMs?: number;
  /**
   * The subagent's own conversation_id (== its transcript filename). Resolved at
   * subagentStop from the on-disk transcript, else by temporal linking.
   */
  childConversationId?: string;
  /**
   * The subagent's internal tool calls, nested under the Task run. From the child
   * conversation's buffered events, or transcript (inputs only).
   */
  tools?: ToolEvent[];
  /** The subagent's final answer text (from its transcript). */
  resultText?: string;
  /** The subagent's own system prompt, recovered from its child conversation's DB state. */
  systemPrompt?: string;
}

/** An assistant thinking block. */
export interface ThoughtEvent {
  text: string;
  duration_ms?: number;
}

/** Buffered events for one in-progress turn (one generation_id). */
export interface TurnBuffer {
  generation_id: string;
  prompt?: string;
  /** Best model label seen for this turn (from beforeSubmitPrompt / stop). */
  model?: string;
  /** Wall-clock ms when the turn started (beforeSubmitPrompt). */
  startMs: number;
  tools: ToolEvent[];
  thoughts: ThoughtEvent[];
  subagents: SubagentEvent[];
  /** Final assistant text (afterAgentResponse). */
  finalText?: string;
  /** Per-turn token usage (afterAgentResponse / stop). */
  usage?: UsageFields;
  /** Turn status from stop. */
  status?: string;
}

/** State for one conversation (thread). */
export interface ConversationState {
  /** In-progress turn buffers keyed by generation_id. */
  turns: Record<string, TurnBuffer>;
  /** Number of turns already finalized (for "Cursor Turn N" naming). */
  turn_count: number;
  /** ISO timestamp of last update (for pruning). */
  updated: string;
}

export interface TracingState {
  [conversationId: string]: ConversationState;
}
