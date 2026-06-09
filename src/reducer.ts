/**
 * Pure state reducers — one per hook event.
 *
 * Each takes the current TracingState + a hook input + a wall-clock timestamp
 * and returns the next state. Hooks call these inside atomicUpdateState; tests
 * drive them directly over recorded hook logs. Keeping them pure (no I/O) makes
 * the event-buffer logic fully unit-testable.
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
import { getConversationState, newTurnBuffer, pruneOldConversations } from "./state.js";
import { parseToolOutput, preferModel, type SubagentToolCall } from "./normalize.js";

function touch(conv: { updated: string }): void {
  conv.updated = new Date().toISOString();
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

export function reduceBeforeSubmitPrompt(
  state: TracingState,
  input: BeforeSubmitPromptInput,
  nowMs: number,
): TracingState {
  const conv = getConversationState(state, input.conversation_id);
  const turn = newTurnBuffer(input.generation_id, nowMs);
  turn.prompt = input.prompt;
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
  const conv = getConversationState(state, input.conversation_id);
  const turn = conv.turns[input.generation_id] ?? newTurnBuffer(input.generation_id, nowMs);
  turn.model = preferModel(turn.model, input.model);
  turn.tools.push({
    tool_use_id: input.tool_use_id,
    name: input.tool_name,
    input: input.tool_input ?? {},
    output: parseToolOutput(input.tool_output),
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
  const conv = getConversationState(state, input.conversation_id);
  const turn = conv.turns[input.generation_id] ?? newTurnBuffer(input.generation_id, nowMs);
  turn.model = preferModel(turn.model, input.model);
  turn.tools.push({
    tool_use_id: input.tool_use_id,
    name: input.tool_name,
    input: input.tool_input ?? {},
    error: input.error_message,
    failure_type: input.failure_type,
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
  const conv = getConversationState(state, input.conversation_id);
  const turn = conv.turns[input.generation_id] ?? newTurnBuffer(input.generation_id, nowMs);
  turn.finalText = input.text;
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
  const conv = getConversationState(state, parentConv);
  const turnId = latestTurnId(conv.turns);
  const turn = turnId ? conv.turns[turnId] : newTurnBuffer(input.generation_id, nowMs);
  turn.subagents.push({
    subagent_id: input.subagent_id,
    subagent_type: input.subagent_type,
    task: input.task,
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
 * In-memory fallback for linking a subagent to its child conversation when the
 * on-disk transcript could not be resolved: the child is an orphan conversation
 * (never `stop`s, so turn_count stays 0) whose buffered tools fall within the
 * subagent's [start, stop] window. Unambiguous for a single subagent; parallel
 * workers are deferred.
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
  const conv = getConversationState(state, parentConv);

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

  target.status = input.status;
  target.duration_ms = input.duration_ms;
  target.endMs = nowMs;
  if (resolved?.resultText) target.resultText = resolved.resultText;

  let next: TracingState = { ...state, [parentConv]: conv };

  // Prefer the child conversation's rich (input+output+duration) buffered tools.
  const childConv =
    resolved?.childConversationId ?? findChildConversation(next, parentConv, target.startMs, nowMs);
  if (childConv && next[childConv]) {
    target.childConversationId = childConv;
    target.tools = collectTools(next[childConv]);
    const { [childConv]: _consumed, ...rest } = next;
    next = rest;
  } else if (resolved?.toolCalls?.length) {
    // Fallback: transcript tool calls (inputs only, synthesized timing).
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
  const conv = getConversationState(state, input.conversation_id);
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
  turn.status = input.status;
  turn.model = preferModel(turn.model, input.model);

  const turnNum = conv.turn_count + 1;
  delete conv.turns[input.generation_id];
  conv.turn_count += 1;
  touch(conv);

  const nextState = pruneOldConversations({ ...state, [input.conversation_id]: conv }, nowMs);
  return { state: nextState, buffer: turn, turnNum };
}
