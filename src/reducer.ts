/**
 * Pure state reducers — one per hook event, mapping (state, input, timestamp) to
 * next state. The only side effect is a log line, so still fully unit-testable.
 */

import type {
  TracingState,
  TurnMode,
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
  SweepClaim,
  TurnOrigin,
} from "./types.js";
import {
  deleteOwnEntry,
  getConversationState,
  newTurnBuffer,
  nextTurnNum,
  ownEntry,
  pruneOldConversations,
  setOwnEntry,
} from "./state.js";
import { MAX_UPLOAD_ATTEMPTS } from "./constants.js";
import { warn } from "./logger.js";
import {
  extractMcpError,
  parseToolOutput,
  preferModel,
  type SubagentToolCall,
} from "./normalize.js";

function touch(conv: { updated: string }, nowMs: number = Date.now()): void {
  conv.updated = new Date(nowMs).toISOString();
}

function forgetSweptTurn(conv: ConversationState, generationId: string): void {
  if (!conv.sweepFinalizedGenerations) return;
  const stillSwept = conv.sweepFinalizedGenerations.filter((id) => id !== generationId);
  if (stillSwept.length) conv.sweepFinalizedGenerations = stillSwept;
  else delete conv.sweepFinalizedGenerations;
}

function dropPendingUpload(conv: ConversationState, generationId: string): void {
  if (!conv.pending) return;
  deleteOwnEntry(conv.pending, generationId);
  if (Object.keys(conv.pending).length === 0) delete conv.pending;
}

function reopenSweptTurn(conv: ConversationState, generationId: string): boolean {
  const entry = ownEntry(conv.pending, generationId);
  if (!entry || !conv.sweepFinalizedGenerations?.includes(generationId)) return false;
  setOwnEntry(conv.turns, generationId, entry.buffer);
  dropPendingUpload(conv, generationId);
  return true;
}

function acceptLateEvent(
  conv: ConversationState,
  conversationId: string,
  input: { hook_event_name: string; generation_id: string },
): boolean {
  const gen = input.generation_id;
  if (conv.completedOffGenerations?.includes(gen)) return false;
  if (conv.stopFinalizedGenerations?.includes(gen)) return false;
  if (!conv.sweepFinalizedGenerations?.includes(gen)) return true;
  if (ownEntry(conv.turns, gen)) return true;
  if (!reopenSweptTurn(conv, gen)) return false;
  warn(
    `Sweep recovered conversation ${conversationId} generation ${gen} too early; reopening it for a late ${input.hook_event_name}`,
  );
  return true;
}

function openTurn(conv: ConversationState, generationId: string, nowMs: number): TurnBuffer {
  return (
    ownEntry(conv.turns, generationId) ?? newTurnBuffer(generationId, nowMs, nextTurnNum(conv))
  );
}

/** Pick the in-progress turn with the largest startMs (the active turn). */
function latestTurn(turns: Record<string, TurnBuffer>): TurnBuffer | undefined {
  let best: TurnBuffer | undefined;
  for (const candidate of Object.values(turns)) {
    if (!best || candidate.startMs > best.startMs) best = candidate;
  }
  return best;
}

export function reduceBeforeSubmitPrompt(
  state: TracingState,
  input: BeforeSubmitPromptInput,
  nowMs: number,
  mode: TurnMode = "full",
  origin?: TurnOrigin,
): TracingState {
  const conv = getConversationState(state, input.conversation_id);
  if (!acceptLateEvent(conv, input.conversation_id, input)) return state;
  // Duplicate delivery must not change a running generation or its snapshot.
  if (ownEntry(conv.turns, input.generation_id)) return state;
  const turn = newTurnBuffer(input.generation_id, nowMs, nextTurnNum(conv));
  turn.tracingMode = mode;
  turn.origin = origin;
  turn.prompt = mode === "off" ? undefined : input.prompt;
  turn.model = input.model;
  setOwnEntry(conv.turns, input.generation_id, turn);
  touch(conv);
  return pruneOldConversations({ ...state, [input.conversation_id]: conv });
}

export function reducePostToolUse(
  state: TracingState,
  input: PostToolUseInput,
  nowMs: number,
): TracingState {
  const conv = getConversationState(state, input.conversation_id);
  if (!acceptLateEvent(conv, input.conversation_id, input)) return state;
  const turn = openTurn(conv, input.generation_id, nowMs);
  turn.model = preferModel(turn.model, input.model);
  const output = parseToolOutput(input.tool_output);
  turn.tools.push({
    tool_use_id: input.tool_use_id,
    name: input.tool_name,
    input: input.tool_input ?? {},
    output,
    // Cursor never fires postToolUseFailure for MCP tools; a failed MCP call
    // arrives here with isError in the output. Flag it so the run is an error.
    error: extractMcpError(input.tool_name, output),
    duration: input.duration,
    endMs: nowMs,
  });
  setOwnEntry(conv.turns, input.generation_id, turn);
  touch(conv);
  return { ...state, [input.conversation_id]: conv };
}

export function reducePostToolUseFailure(
  state: TracingState,
  input: PostToolUseFailureInput,
  nowMs: number,
): TracingState {
  const conv = getConversationState(state, input.conversation_id);
  if (!acceptLateEvent(conv, input.conversation_id, input)) return state;
  const turn = openTurn(conv, input.generation_id, nowMs);
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
  setOwnEntry(conv.turns, input.generation_id, turn);
  touch(conv);
  return { ...state, [input.conversation_id]: conv };
}

export function reduceAfterAgentResponse(
  state: TracingState,
  input: AfterAgentResponseInput,
  nowMs: number,
): TracingState {
  const conv = getConversationState(state, input.conversation_id);
  if (!acceptLateEvent(conv, input.conversation_id, input)) return state;
  const turn = openTurn(conv, input.generation_id, nowMs);
  turn.finalText = input.text;
  turn.finalTextArrivedMs = nowMs;
  turn.model = preferModel(turn.model, input.model);
  turn.usage = {
    input_tokens: input.input_tokens,
    output_tokens: input.output_tokens,
    cache_read_tokens: input.cache_read_tokens,
    cache_write_tokens: input.cache_write_tokens,
  };
  setOwnEntry(conv.turns, input.generation_id, turn);
  touch(conv);
  return { ...state, [input.conversation_id]: conv };
}

/** Resolve privacy evidence only; never change the existing latest-turn parentage. */
function subagentLaunchMode(
  conv: ConversationState,
  input: SubagentStartInput,
): "full" | "metadata" {
  const candidates = Object.values(conv.turns);
  // Captured Cursor launches often repeat the conversation ID as generation_id.
  // Only a distinct, actually buffered generation is explicit ownership evidence.
  const generation = ![
    input.conversation_id,
    input.parent_conversation_id,
    input.session_id,
  ].includes(input.generation_id)
    ? ownEntry(conv.turns, input.generation_id)
    : undefined;
  const linked = input.tool_call_id
    ? candidates.filter((t) => t.tools.some((tool) => tool.tool_use_id === input.tool_call_id))
    : [];
  const proven = generation ? [generation, ...linked] : linked;
  const possible = proven.length ? proven : candidates;
  return possible.length > 0 && possible.every((t) => t.tracingMode === "full")
    ? "full"
    : "metadata";
}

export function reduceSubagentStart(
  state: TracingState,
  input: SubagentStartInput,
  nowMs: number,
): TracingState {
  const parentConv = input.parent_conversation_id ?? input.conversation_id;
  const conv = getConversationState(state, parentConv);
  if (!acceptLateEvent(conv, parentConv, input)) return state;
  const tracingMode = subagentLaunchMode(conv, input);
  const turn =
    latestTurn(conv.turns) ?? newTurnBuffer(input.generation_id, nowMs, nextTurnNum(conv));
  turn.subagents.push({
    tracingMode,
    subagent_id: input.subagent_id,
    subagent_type: input.subagent_type,
    task: input.task,
    model: input.subagent_model ?? input.model,
    is_parallel_worker: input.is_parallel_worker,
    startMs: nowMs,
  });
  setOwnEntry(conv.turns, turn.generation_id, turn);
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
  target.description = input.description;
  target.message_count = input.message_count;
  target.tool_call_count = input.tool_call_count;
  target.loop_count = input.loop_count;
  target.endMs = nowMs;
  if (resolved?.resultText) target.resultText = resolved.resultText;

  let next: TracingState = { ...state, [parentConv]: conv };

  // Prefer the child conversation's rich (input+output+duration) buffered tools.
  const resolvedChild =
    resolved?.childConversationId ?? findChildConversation(next, parentConv, target.startMs, nowMs);
  const childConv = resolvedChild === parentConv ? undefined : resolvedChild;
  const child = childConv ? ownEntry(next, childConv) : undefined;
  if (childConv && child) {
    target.childConversationId = childConv;
    target.tools = collectTools(child);
    if (Object.keys(child.pending ?? {}).length > 0) {
      next = { ...next, [childConv]: { ...child, turns: {} } };
    } else {
      const { [childConv]: _consumed, ...rest } = next;
      next = rest;
    }
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
  if (!ownEntry(conv.turns, input.generation_id)) reopenSweptTurn(conv, input.generation_id);
  const turn = ownEntry(conv.turns, input.generation_id);
  if (!turn) {
    return { state, turnNum: 0 };
  }
  const alreadyCountedBySweep =
    conv.sweepFinalizedGenerations?.includes(input.generation_id) ?? false;

  // stop carries the authoritative final usage + status.
  turn.usage = {
    input_tokens: input.input_tokens,
    output_tokens: input.output_tokens,
    cache_read_tokens: input.cache_read_tokens,
    cache_write_tokens: input.cache_write_tokens,
  };
  turn.status = input.status;
  turn.model = preferModel(turn.model, input.model);

  turn.turnNum ??= nextTurnNum(conv);
  const turnNum = turn.turnNum;
  if (turn.tracingMode === "off") {
    (conv.completedOffGenerations ??= []).push(input.generation_id);
  } else {
    (conv.stopFinalizedGenerations ??= []).push(input.generation_id);
    const pending = (conv.pending ??= {});
    setOwnEntry(pending, input.generation_id, {
      buffer: turn,
      turnNum,
      claimedAt: nowMs,
      attempts: 1,
    });
  }
  forgetSweptTurn(conv, input.generation_id);
  delete turn.sweptAtMs;
  deleteOwnEntry(conv.turns, input.generation_id);
  if (!alreadyCountedBySweep) conv.turn_count += 1;
  touch(conv, nowMs);

  const nextState = pruneOldConversations({ ...state, [input.conversation_id]: conv }, nowMs);
  return { state: nextState, buffer: turn, turnNum };
}

export function reduceUploadSettled(
  state: TracingState,
  conversationId: string,
  generationId: string,
  claimedAt: number,
): TracingState {
  const conv = ownEntry(state, conversationId);
  const entry = ownEntry(conv?.pending, generationId);
  if (!conv || !entry || entry.claimedAt !== claimedAt) return state;
  dropPendingUpload(conv, generationId);
  if (conv.sweepFinalizedGenerations?.includes(generationId)) {
    entry.buffer.sweptAtMs = entry.claimedAt;
    setOwnEntry(conv.turns, generationId, entry.buffer);
  }
  return { ...state, [conversationId]: conv };
}

export interface SweepResult {
  state: TracingState;
  claims: SweepClaim[];
}

function lastActivityMs(turn: TurnBuffer): number {
  return Math.max(
    turn.startMs,
    turn.finalTextArrivedMs ?? turn.startMs,
    ...turn.tools.map((t) => t.endMs),
    ...turn.subagents.map((s) => s.endMs ?? s.startMs),
  );
}

function hasOpenSubagent(turn: TurnBuffer): boolean {
  return turn.subagents.some((s) => s.endMs == null);
}

function allBuffers(conv: ConversationState): TurnBuffer[] {
  const pending = Object.values(conv.pending ?? {}).map((entry) => entry.buffer);
  return [...Object.values(conv.turns), ...pending];
}

function threadsRunningASubagent(state: TracingState, nowMs: number): Set<string> {
  const threads = new Set<string>();
  for (const [parentConv, conv] of Object.entries(state)) {
    const openStarts = allBuffers(conv)
      .flatMap((turn) => turn.subagents)
      .filter((s) => s.endMs == null)
      .map((s) => s.startMs);
    for (const startMs of openStarts) {
      const child = findChildConversation(state, parentConv, startMs, nowMs);
      if (child) threads.add(child);
    }
  }
  return threads;
}

interface ConversationSweep {
  claims: SweepClaim[];
  changed: boolean;
}

function retryPendingUploads(
  conv: ConversationState,
  conversationId: string,
  cutoff: number,
  nowMs: number,
): ConversationSweep {
  const claims: SweepClaim[] = [];
  let changed = false;

  for (const [generationId, entry] of Object.entries(conv.pending ?? {})) {
    if (entry.claimedAt > cutoff) continue;
    changed = true;
    if (entry.attempts >= MAX_UPLOAD_ATTEMPTS) {
      dropPendingUpload(conv, generationId);
      warn(
        `Dropping turn ${entry.turnNum} of conversation ${conversationId} after ${entry.attempts} failed upload attempts`,
      );
      continue;
    }
    entry.attempts += 1;
    entry.claimedAt = nowMs;
    claims.push({
      conversationId,
      generationId,
      buffer: entry.buffer,
      turnNum: entry.turnNum,
      claimedAt: nowMs,
    });
  }

  return { claims, changed };
}

function claimIdleTurns(
  conv: ConversationState,
  conversationId: string,
  cutoff: number,
  nowMs: number,
): ConversationSweep {
  const claims: SweepClaim[] = [];
  let changed = false;

  for (const [generationId, turn] of Object.entries(conv.turns)) {
    if (hasOpenSubagent(turn)) continue;
    const lastMs = lastActivityMs(turn);
    const recoveredAt = turn.sweptAtMs;

    if (recoveredAt != null && lastMs <= recoveredAt) {
      if (recoveredAt > cutoff) continue;
      deleteOwnEntry(conv.turns, generationId);
      changed = true;
      continue;
    }
    if (lastMs > cutoff) continue;

    changed = true;
    deleteOwnEntry(conv.turns, generationId);
    if (turn.tracingMode === "off") {
      (conv.completedOffGenerations ??= []).push(generationId);
      continue;
    }

    turn.turnNum ??= nextTurnNum(conv);
    const swept = (conv.sweepFinalizedGenerations ??= []);
    if (!swept.includes(generationId)) {
      swept.push(generationId);
      conv.turn_count += 1;
    }
    turn.status ??= "incomplete";
    const pending = (conv.pending ??= {});
    setOwnEntry(pending, generationId, {
      buffer: turn,
      turnNum: turn.turnNum,
      claimedAt: nowMs,
      attempts: 1,
    });
    claims.push({
      conversationId,
      generationId,
      buffer: turn,
      turnNum: turn.turnNum,
      claimedAt: nowMs,
    });
  }

  return { claims, changed };
}

export function reduceSweep(
  state: TracingState,
  callerConversationId: string,
  nowMs: number,
  thresholdMs: number,
): SweepResult {
  const claims: SweepClaim[] = [];
  const cutoff = nowMs - thresholdMs;
  const subagentThreads = threadsRunningASubagent(state, nowMs);

  for (const [conversationId, conv] of Object.entries(state)) {
    if (conversationId === callerConversationId) continue;
    if (subagentThreads.has(conversationId)) continue;

    const retried = retryPendingUploads(conv, conversationId, cutoff, nowMs);
    const claimed = claimIdleTurns(conv, conversationId, cutoff, nowMs);
    claims.push(...retried.claims, ...claimed.claims);
    if (retried.changed || claimed.changed) touch(conv, nowMs);
  }

  return { state: { ...state }, claims };
}
