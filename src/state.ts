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
  renameSync,
  fsyncSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import {
  acquireCompatibleDirectoryFileLock,
  type FileLockHandle,
} from "@langchain/plugins-base/storage";
import { warn } from "./logger.js";
import { dirname } from "node:path";
import type { TracingState, ConversationState, TurnBuffer } from "./types.js";
import { hasFileLockTimeoutError } from "./utils/errors.js";
import {
  TURN_STATE_LOCK_CLEANUP_WARNING,
  TURN_STATE_LOCK_TIMEOUT_MESSAGE,
  TURN_STATE_LOCK_TIMEOUT_MS,
} from "./state-constants.js";

// ─── Atomic read-modify-write ────────────────────────────────────────────────

async function acquireLock(stateFilePath: string): Promise<FileLockHandle> {
  try {
    return await acquireCompatibleDirectoryFileLock(stateFilePath, {
      timeoutMs: TURN_STATE_LOCK_TIMEOUT_MS,
    });
  } catch (error) {
    if (hasFileLockTimeoutError(error)) {
      throw new Error(TURN_STATE_LOCK_TIMEOUT_MESSAGE, { cause: error });
    }
    throw error;
  }
}

async function releaseLock(lock: FileLockHandle): Promise<void> {
  try {
    await lock.release();
  } catch {
    warn(TURN_STATE_LOCK_CLEANUP_WARNING);
  }
}

/** Atomically read state, apply `fn`, write it back; a file lock serializes hooks. */
export async function atomicUpdateState(
  stateFilePath: string,
  fn: (state: TracingState) => TracingState,
): Promise<void> {
  const lock = await acquireLock(stateFilePath);
  try {
    const state = loadState(stateFilePath);
    saveState(stateFilePath, fn(state));
  } finally {
    await releaseLock(lock);
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

const CONVERSATION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Remove conversations whose `updated` timestamp is older than 24 hours. */
export function pruneOldConversations(state: TracingState, now: number = Date.now()): TracingState {
  const cutoff = now - CONVERSATION_MAX_AGE_MS;
  const pruned: TracingState = {};
  for (const [conversationId, conv] of Object.entries(state)) {
    const updatedMs = conv.updated ? new Date(conv.updated).getTime() : 0;
    if (updatedMs >= cutoff) {
      setOwnEntry(pruned, conversationId, conv);
    }
  }
  return pruned;
}
