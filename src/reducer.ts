/**
 * Pure state reducers — one per hook event, mapping (state, input, timestamp) to
 * next state. No I/O, so fully unit-testable.
 */

import type {
  TracingState,
  ConversationState,
  TurnBuffer,
  ToolEvent,
  SubagentEvent,
  BeforeSubmitPromptInput,
  PostToolUseInput,
  PostToolUseFailureInput,
  AfterAgentResponseInput,
  SubagentStartInput,
  SubagentStopInput,
  StopInput,
} from "./types.js";
import {
  enforceConversationTracing,
  getConversationState,
  newTurnBuffer,
  pruneOldConversations,
  sanitizeMetadataTurn,
} from "./state.js";
import { tracingMode } from "./trace-control.js";
import {
  extractMcpError,
  parseToolOutput,
  preferModel,
  type SubagentToolCall,
} from "./normalize.js";

function touch(conv: { updated: string }): void {
  conv.updated = new Date().toISOString();
}

function safeStatus(status: string | undefined): "completed" | "error" | undefined {
  if (status == null) return undefined;
  return status === "completed" ? "completed" : "error";
}

/** Pick the in-progress turn with the largest startMs (the active turn). */
function latestTurnId(turns: Record<string, TurnBuffer>): string | undefined {
  let best: string | undefined;
  let bestMs = -1;
  for (const [id, t] of Object.entries(turns)) {
    if (t.startMs > bestMs) {
      bestMs = t.startMs;
      best = id;
    }
  }
  return best;
}

function openSubagentParent(
  state: TracingState,
  childConversationId: string,
): { conversationId: string; generationId: string; mode: "full" | "metadata" } | undefined {
  const candidates: Array<{
    conversationId: string;
    generationId: string;
    mode: "full" | "metadata";
  }> = [];
  for (const [conversationId, conv] of Object.entries(state)) {
    if (conversationId === childConversationId) continue;
    for (const turn of Object.values(conv.turns)) {
      if (turn.subagents.some((subagent) => subagent.endMs == null)) {
        candidates.push({
          conversationId,
          generationId: turn.generation_id,
          mode: turn.tracing_mode,
        });
      }
    }
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    return {
      conversationId: "__unresolved_subagent__",
      generationId: "__unresolved_subagent__",
      mode: "metadata",
    };
  }
  return undefined;
}

function conversationForEvent(state: TracingState, conversationId: string): ConversationState {
  const conv = enforceConversationTracing(getConversationState(state, conversationId));
  if (conv.tracing === "metadata" || conv.parent_conversation_id) return conv;

  const parent = openSubagentParent(state, conversationId);
  if (parent) {
    conv.tracing = "metadata";
    enforceConversationTracing(conv);
  }
  return conv;
}

function eventTracingMode(
  state: TracingState,
  conversationId: string,
  conv: ConversationState,
): "full" | "metadata" {
  if (conv.tracing === "metadata") return "metadata";
  if (conv.parent_conversation_id && conv.parent_generation_id) {
    return (
      state[conv.parent_conversation_id]?.turns[conv.parent_generation_id]?.tracing_mode ??
      "metadata"
    );
  }
  return tracingMode(state, conversationId);
}

export function reduceBeforeSubmitPrompt(
  state: TracingState,
  input: BeforeSubmitPromptInput,
  nowMs: number,
): TracingState {
  const conv = conversationForEvent(state, input.conversation_id);
  const turn =
    conv.turns[input.generation_id] ??
    newTurnBuffer(input.generation_id, nowMs, eventTracingMode(state, input.conversation_id, conv));
  if (turn.tracing_mode === "full") turn.prompt = input.prompt;
  turn.model = input.model;
  conv.turns[input.generation_id] = turn;
  touch(conv);
  return pruneOldConversations({ ...state, [input.conversation_id]: conv });
}

export function reducePostToolUse(
  state: TracingState,
  input: PostToolUseInput,
  nowMs: number,
): TracingState {
  const conv = conversationForEvent(state, input.conversation_id);
  const turn =
    conv.turns[input.generation_id] ??
    newTurnBuffer(input.generation_id, nowMs, eventTracingMode(state, input.conversation_id, conv));
  turn.model = preferModel(turn.model, input.model);
  const output = turn.tracing_mode === "full" ? parseToolOutput(input.tool_output) : undefined;
  turn.tools.push({
    tool_use_id: turn.tracing_mode === "full" ? input.tool_use_id : "",
    name: input.tool_name,
    input: turn.tracing_mode === "full" ? (input.tool_input ?? {}) : {},
    output,
    error: turn.tracing_mode === "full" ? extractMcpError(input.tool_name, output) : undefined,
    duration: input.duration,
    endMs: nowMs,
  });
  conv.turns[input.generation_id] = turn;
  touch(conv);
  return { ...state, [input.conversation_id]: conv };
}

export function reducePostToolUseFailure(
  state: TracingState,
  input: PostToolUseFailureInput,
  nowMs: number,
): TracingState {
  const conv = conversationForEvent(state, input.conversation_id);
  const turn =
    conv.turns[input.generation_id] ??
    newTurnBuffer(input.generation_id, nowMs, eventTracingMode(state, input.conversation_id, conv));
  turn.model = preferModel(turn.model, input.model);
  turn.tools.push({
    tool_use_id: turn.tracing_mode === "full" ? input.tool_use_id : "",
    name: input.tool_name,
    input: turn.tracing_mode === "full" ? (input.tool_input ?? {}) : {},
    error: turn.tracing_mode === "full" ? input.error_message : undefined,
    failed: true,
    failure_type: turn.tracing_mode === "full" ? input.failure_type : undefined,
    duration: input.duration,
    endMs: nowMs,
  });
  conv.turns[input.generation_id] = turn;
  touch(conv);
  return { ...state, [input.conversation_id]: conv };
}

export function reduceAfterAgentResponse(
  state: TracingState,
  input: AfterAgentResponseInput,
  nowMs: number,
): TracingState {
  const conv = conversationForEvent(state, input.conversation_id);
  const turn =
    conv.turns[input.generation_id] ??
    newTurnBuffer(input.generation_id, nowMs, eventTracingMode(state, input.conversation_id, conv));
  if (turn.tracing_mode === "full") turn.finalText = input.text;
  turn.model = preferModel(turn.model, input.model);
  turn.usage = {
    input_tokens: input.input_tokens,
    output_tokens: input.output_tokens,
    cache_read_tokens: input.cache_read_tokens,
    cache_write_tokens: input.cache_write_tokens,
  };
  conv.turns[input.generation_id] = turn;
  touch(conv);
  return { ...state, [input.conversation_id]: conv };
}

export function reduceSubagentStart(
  state: TracingState,
  input: SubagentStartInput,
  nowMs: number,
): TracingState {
  const parentConv = input.parent_conversation_id ?? input.conversation_id;
  const conv = conversationForEvent(state, parentConv);
  const turnId = latestTurnId(conv.turns);
  const turn = turnId
    ? conv.turns[turnId]
    : newTurnBuffer(input.generation_id, nowMs, tracingMode(state, parentConv));
  turn.subagents.push({
    subagent_id: input.subagent_id,
    subagent_type: input.subagent_type,
    task: turn.tracing_mode === "full" ? input.task : "",
    model: input.subagent_model ?? input.model,
    is_parallel_worker: input.is_parallel_worker,
    startMs: nowMs,
  });
  conv.turns[turn.generation_id] = turn;
  touch(conv);
  return { ...state, [parentConv]: conv };
}

/** Data recovered from the on-disk subagent transcript (resolved in the hook). */
export interface ResolvedSubagent {
  /** The subagent's own conversation_id (= transcript filename). */
  childConversationId?: string;
  /** Tool calls from the transcript (inputs only) — fallback when no child buffer. */
  toolCalls?: SubagentToolCall[];
  resultText?: string;
}

/** Flatten and time-order every buffered tool event across a conversation. */
function collectTools(conv: ConversationState): ToolEvent[] {
  const tools: ToolEvent[] = [];
  for (const turn of Object.values(conv.turns)) tools.push(...turn.tools);
  return tools.sort((a, b) => a.endMs - b.endMs);
}

/**
 * Fallback: link a subagent to the orphan conversation (turn_count 0) whose
 * buffered tools fall in its window. Single-subagent only.
 */
function findChildConversation(
  state: TracingState,
  parentConv: string,
  startMs: number,
  nowMs: number,
): string | undefined {
  const slack = 2_000;
  let best: string | undefined;
  let bestScore = 0;
  for (const [convId, conv] of Object.entries(state)) {
    if (convId === parentConv || conv.turn_count !== 0) continue;
    const inWindow = collectTools(conv).filter(
      (t) => t.endMs >= startMs - slack && t.endMs <= nowMs + slack,
    ).length;
    if (inWindow > bestScore) {
      bestScore = inWindow;
      best = convId;
    }
  }
  return best;
}

/** Synthetic ToolEvent from a transcript tool call, spread across the window. */
function transcriptToolEvent(
  call: SubagentToolCall,
  index: number,
  count: number,
  startMs: number,
  endMs: number,
): ToolEvent {
  const span = Math.max(0, endMs - startMs);
  const slice = count > 0 ? span / count : 0;
  const end = Math.round(startMs + slice * (index + 1));
  return {
    tool_use_id: `subagent-tool-${index}`,
    name: call.name,
    input: call.input,
    duration: slice / 1000,
    endMs: end,
  };
}

export function reduceSubagentStop(
  state: TracingState,
  input: SubagentStopInput,
  nowMs: number,
  resolved?: ResolvedSubagent,
): TracingState {
  const parentConv = input.parent_conversation_id ?? input.conversation_id;
  const conv = conversationForEvent(state, parentConv);

  let target: SubagentEvent | undefined;
  for (const turn of Object.values(conv.turns)) {
    const sub = turn.subagents.find((s) => s.subagent_id === input.subagent_id && s.endMs == null);
    if (sub) {
      target = sub;
      break;
    }
  }

  if (!target) {
    touch(conv);
    return { ...state, [parentConv]: conv };
  }

  const targetTurn = Object.values(conv.turns).find((turn) => turn.subagents.includes(target));
  const metadataOnly = targetTurn?.tracing_mode === "metadata";
  target.status = metadataOnly ? safeStatus(input.status) : input.status;
  target.duration_ms = input.duration_ms;
  target.message_count = input.message_count;
  target.tool_call_count = input.tool_call_count;
  target.loop_count = input.loop_count;
  target.endMs = nowMs;
  if (!metadataOnly) {
    target.description = input.description;
    if (resolved?.resultText) target.resultText = resolved.resultText;
  }

  let next: TracingState = { ...state, [parentConv]: conv };

  // Prefer the child conversation's rich (input+output+duration) buffered tools.
  const childConv =
    resolved?.childConversationId ?? findChildConversation(next, parentConv, target.startMs, nowMs);
  if (childConv && next[childConv]) {
    target.childConversationId = childConv;
    target.tools = metadataOnly
      ? collectTools(next[childConv]).map((tool) => ({
          tool_use_id: "",
          name: tool.name,
          input: {},
          failed: tool.failed ?? tool.error != null,
          duration: tool.duration,
          endMs: tool.endMs,
        }))
      : collectTools(next[childConv]);
    const { [childConv]: _consumed, ...rest } = next;
    next = rest;
  } else if (!metadataOnly && resolved?.toolCalls?.length) {
    const calls = resolved.toolCalls;
    target.childConversationId = resolved.childConversationId;
    target.tools = calls.map((c, i) =>
      transcriptToolEvent(c, i, calls.length, target.startMs, nowMs),
    );
  }

  touch(conv);
  return next;
}

export interface StopResult {
  state: TracingState;
  /** The finalized turn to trace, or undefined if there was no buffered turn. */
  buffer?: TurnBuffer;
  turnNum: number;
}

export function reduceStop(state: TracingState, input: StopInput, nowMs: number): StopResult {
  const conv = conversationForEvent(state, input.conversation_id);
  const turn = conv.turns[input.generation_id];
  if (!turn) {
    return { state, turnNum: 0 };
  }

  // stop carries the authoritative final usage + status.
  turn.usage = {
    input_tokens: input.input_tokens,
    output_tokens: input.output_tokens,
    cache_read_tokens: input.cache_read_tokens,
    cache_write_tokens: input.cache_write_tokens,
  };
  turn.status = turn.tracing_mode === "metadata" ? safeStatus(input.status) : input.status;
  turn.endMs = nowMs;
  turn.model = preferModel(turn.model, input.model);
  if (conv.tracing === "metadata") sanitizeMetadataTurn(turn);

  if (conv.parent_conversation_id) {
    touch(conv);
    return { state: { ...state, [input.conversation_id]: conv }, turnNum: 0 };
  }

  const turnNum = conv.turn_count + 1;
  delete conv.turns[input.generation_id];
  conv.turn_count += 1;
  touch(conv);

  const nextState = pruneOldConversations({ ...state, [input.conversation_id]: conv }, nowMs);
  return { state: nextState, buffer: turn, turnNum };
}
