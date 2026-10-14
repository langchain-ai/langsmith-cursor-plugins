/**
 * Persistent per-turn event buffer in a conversation_id-keyed JSON file; `stop`
 * posts the trace and clears the turn. File-locked.
 */

import { createStateStore, pruneStateEntries } from "@langchain/plugins-base/storage";
import { CONVERSATION_MAX_AGE_MS, LEGACY_STATE_FILE_NAME, STATE_FILE_NAME } from "./constants.js";
import { warn } from "./logger.js";
import type { TracingState, ConversationState, TurnBuffer } from "./models/types.js";
import { adoptLegacyFile } from "./utils/legacy-file.js";

/** Atomically read state, apply `fn`, write it back; a file lock serializes hooks. */
export async function atomicUpdateState(
  stateFilePath: string,
  fn: (state: TracingState) => TracingState,
): Promise<void> {
  await stateStore(stateFilePath).update(fn);
}

export function readState(stateFilePath: string): TracingState {
  return stateStore(stateFilePath).read();
}

function stateStore(stateFilePath: string) {
  adoptLegacyFile(stateFilePath, STATE_FILE_NAME, LEGACY_STATE_FILE_NAME);
  return createStateStore<ConversationState>({ path: stateFilePath, warn });
}

// ─── State helpers ───────────────────────────────────────────────────────────

export function ownEntry<T>(map: Record<string, T> | undefined, id: string): T | undefined {
  return map !== undefined && Object.hasOwn(map, id) ? map[id] : undefined;
}

export function setOwnEntry<T>(map: Record<string, T>, id: string, value: T): void {
  Object.defineProperty(map, id, { value, writable: true, enumerable: true, configurable: true });
}

export function deleteOwnEntry<T>(map: Record<string, T>, id: string): void {
  delete map[id];
}

export function getConversationState(
  state: TracingState,
  conversationId: string,
): ConversationState {
  return ownEntry(state, conversationId) ?? { turns: {}, turn_count: 0, updated: "" };
}

export function nextTurnNum(conv: ConversationState): number {
  conv.turns_started = (conv.turns_started ?? conv.turn_count) + 1;
  return conv.turns_started;
}

/** Create a fresh, empty turn buffer. */
export function newTurnBuffer(generationId: string, startMs: number, turnNum: number): TurnBuffer {
  return {
    generation_id: generationId,
    turnNum,
    startMs,
    tools: [],
    thoughts: [],
    subagents: [],
  };
}

/** In-progress turn buffer for a generation, or undefined. */
export function getTurnBuffer(
  state: TracingState,
  conversationId: string,
  generationId: string,
): TurnBuffer | undefined {
  return ownEntry(ownEntry(state, conversationId)?.turns, generationId);
}

// ─── Pruning ───────────────────────────────────────────────────────────────

/** Remove conversations whose `updated` timestamp is older than 24 hours. */
export function pruneOldConversations(state: TracingState, now: number = Date.now()): TracingState {
  return pruneStateEntries(state, CONVERSATION_MAX_AGE_MS, now);
}
