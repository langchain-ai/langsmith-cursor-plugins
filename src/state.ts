/**
 * Persistent per-turn event buffer: hooks append to a conversation_id-keyed JSON
 * file; `stop` posts the trace and clears the turn. File-locked.
 */

import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { TracingState, ConversationState, TurnBuffer } from "./types.js";

// ─── Atomic read-modify-write ────────────────────────────────────────────────

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 20;

function lockPath(stateFilePath: string): string {
  return `${stateFilePath}.lock`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(stateFilePath: string): Promise<void> {
  const lock = lockPath(stateFilePath);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  mkdirSync(dirname(stateFilePath), { recursive: true });
  while (Date.now() < deadline) {
    try {
      // O_EXCL | O_CREAT: fails atomically if the file already exists.
      const fd = openSync(lock, "wx");
      closeSync(fd);
      return;
    } catch {
      await sleep(LOCK_RETRY_MS);
    }
  }
  // Stale lock — remove it and proceed rather than deadlocking.
  try {
    unlinkSync(lock);
  } catch {
    /* ignore */
  }
}

function releaseLock(stateFilePath: string): void {
  try {
    unlinkSync(lockPath(stateFilePath));
  } catch {
    /* ignore */
  }
}

/**
 * Atomically read state, apply `fn`, and write the result back.
 * A file lock prevents concurrent hooks from clobbering each other.
 */
export async function atomicUpdateState(
  stateFilePath: string,
  fn: (state: TracingState) => TracingState,
): Promise<void> {
  await acquireLock(stateFilePath);
  try {
    const state = loadState(stateFilePath);
    writeFileSync(stateFilePath, JSON.stringify(fn(state), null, 2));
  } finally {
    releaseLock(stateFilePath);
  }
}

// ─── State helpers ───────────────────────────────────────────────────────────

export function loadState(stateFilePath: string): TracingState {
  try {
    return JSON.parse(readFileSync(stateFilePath, "utf-8")) as TracingState;
  } catch {
    return {};
  }
}

export function saveState(stateFilePath: string, state: TracingState): void {
  mkdirSync(dirname(stateFilePath), { recursive: true });
  writeFileSync(stateFilePath, JSON.stringify(state, null, 2));
}

export function getConversationState(
  state: TracingState,
  conversationId: string,
): ConversationState {
  return state[conversationId] ?? { turns: {}, turn_count: 0, updated: "" };
}

/** Create a fresh, empty turn buffer. */
export function newTurnBuffer(generationId: string, startMs: number): TurnBuffer {
  return {
    generation_id: generationId,
    startMs,
    tools: [],
    thoughts: [],
    subagents: [],
  };
}

/**
 * In-progress turn buffer for a generation, or undefined; callers may lazily
 * create one if hooks fire early.
 */
export function getTurnBuffer(
  state: TracingState,
  conversationId: string,
  generationId: string,
): TurnBuffer | undefined {
  return state[conversationId]?.turns[generationId];
}

// ─── Pruning ───────────────────────────────────────────────────────────────

const CONVERSATION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Remove conversations whose `updated` timestamp is older than 24 hours. */
export function pruneOldConversations(state: TracingState, now: number = Date.now()): TracingState {
  const cutoff = now - CONVERSATION_MAX_AGE_MS;
  const pruned: TracingState = {};
  for (const [conversationId, conv] of Object.entries(state)) {
    const updatedMs = conv.updated ? new Date(conv.updated).getTime() : 0;
    if (updatedMs >= cutoff) {
      pruned[conversationId] = conv;
    }
  }
  return pruned;
}
