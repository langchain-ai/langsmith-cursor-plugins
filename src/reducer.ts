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
  TurnBuffer,
  BeforeSubmitPromptInput,
  PostToolUseInput,
  PostToolUseFailureInput,
  AfterAgentResponseInput,
  SubagentStartInput,
  SubagentStopInput,
  StopInput,
} from "./types.js";
import { getConversationState, newTurnBuffer, pruneOldConversations } from "./state.js";
import { parseToolOutput, preferModel } from "./normalize.js";

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

export function reduceSubagentStop(
  state: TracingState,
  input: SubagentStopInput,
  nowMs: number,
): TracingState {
  const parentConv = input.parent_conversation_id ?? input.conversation_id;
  const conv = getConversationState(state, parentConv);
  for (const turn of Object.values(conv.turns)) {
    const sub = turn.subagents.find((s) => s.subagent_id === input.subagent_id && s.endMs == null);
    if (sub) {
      sub.status = input.status;
      sub.duration_ms = input.duration_ms;
      sub.endMs = nowMs;
      break;
    }
  }
  touch(conv);
  return { ...state, [parentConv]: conv };
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
