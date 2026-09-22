/**
 * Persistent per-turn event buffer in a conversation_id-keyed JSON file; `stop`
 * posts the trace and clears the turn. File-locked.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  rmdirSync,
  renameSync,
  fsyncSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { warn } from "./logger.js";
import { dirname } from "node:path";
import type { TracingState, ConversationState, TurnBuffer } from "./types.js";

// ─── Atomic read-modify-write ────────────────────────────────────────────────

const LOCK_TIMEOUT_MS = 2_000;

function lockPath(stateFilePath: string): string {
  return `${stateFilePath}.lock`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(stateFilePath: string): Promise<void> {
  const lock = lockPath(stateFilePath);
  const deadline = performance.now() + LOCK_TIMEOUT_MS;
  mkdirSync(dirname(stateFilePath), { recursive: true, mode: 0o700 });
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (performance.now() >= deadline)
        throw new Error(
          "Timed out waiting for turn-state lock; confirm no writer is running before removing it",
        );
      await sleep(10 + Math.random() * 20);
    }
  }
}

function releaseLock(stateFilePath: string): void {
  try {
    rmdirSync(lockPath(stateFilePath));
  } catch {
    warn("Turn-state lock cleanup failed; confirm no writer is running before removing it");
  }
}

/** Atomically read state, apply `fn`, write it back; a file lock serializes hooks. */
export async function atomicUpdateState(
  stateFilePath: string,
  fn: (state: TracingState) => TracingState,
): Promise<void> {
  await acquireLock(stateFilePath);
  try {
    const state = loadState(stateFilePath);
    saveState(stateFilePath, fn(state));
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
  mkdirSync(dirname(stateFilePath), { recursive: true, mode: 0o700 });
  const temp = `${stateFilePath}.${process.pid}.${randomUUID()}.tmp`;
  let committed = false;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(state, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, stateFilePath);
    committed = true;
    try {
      const fd = openSync(dirname(stateFilePath), "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      warn("Turn snapshot saved, but crash durability could not be confirmed");
    }
  } finally {
    if (!committed) {
      try {
        unlinkSync(temp);
      } catch {
        /* best effort */
      }
    }
  }
}

export function getConversationState(
  state: TracingState,
  conversationId: string,
): ConversationState {
  return state[conversationId] ?? { turns: {}, turn_count: 0, updated: "" };
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
