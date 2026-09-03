/** Persistent per-turn event buffer, serialized across hook processes. */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { TracingState, ConversationState, TurnBuffer, TracingMode } from "./types.js";

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 20;
const MALFORMED_LOCK_MAX_AGE_MS = LOCK_TIMEOUT_MS * 2;
export const CORRUPT_STATE_KEY = "__langsmith_corrupt_state__";

interface LockOwner {
  pid: number;
  id: string;
  createdAt: number;
}

function lockPath(stateFilePath: string): string {
  return `${stateFilePath}.lock`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function removeRecoverableLock(lock: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(lock, "utf-8")) as Partial<LockOwner>;
    if (
      typeof owner.pid !== "number" ||
      typeof owner.id !== "string" ||
      typeof owner.createdAt !== "number" ||
      !processIsDead(owner.pid)
    ) {
      return false;
    }
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs < MALFORMED_LOCK_MAX_AGE_MS) return false;
    } catch {
      return false;
    }
  }
  try {
    unlinkSync(lock);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(stateFilePath: string): Promise<string> {
  const lock = lockPath(stateFilePath);
  const owner: LockOwner = { pid: process.pid, id: randomUUID(), createdAt: Date.now() };
  const serialized = JSON.stringify(owner);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  mkdirSync(dirname(stateFilePath), { recursive: true });
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try {
        writeFileSync(fd, serialized);
      } finally {
        closeSync(fd);
      }
      return serialized;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (removeRecoverableLock(lock)) continue;
      await sleep(LOCK_RETRY_MS);
    }
  }
  throw new Error("Timed out acquiring LangSmith state lock");
}

function releaseLock(stateFilePath: string, owner: string): void {
  try {
    if (readFileSync(lockPath(stateFilePath), "utf-8") === owner)
      unlinkSync(lockPath(stateFilePath));
  } catch {}
}

export async function atomicUpdateState(
  stateFilePath: string,
  fn: (state: TracingState) => TracingState,
): Promise<void> {
  const owner = await acquireLock(stateFilePath);
  try {
    saveState(stateFilePath, fn(loadState(stateFilePath)));
  } finally {
    releaseLock(stateFilePath, owner);
  }
}

function corruptState(policies: TracingState = {}): TracingState {
  return {
    ...policies,
    [CORRUPT_STATE_KEY]: { turns: {}, turn_count: 0, updated: "", tracing: "metadata" },
  };
}

function stickyMetadataPolicies(value: Record<string, unknown>): TracingState {
  const policies: TracingState = {};
  for (const [id, entry] of Object.entries(value)) {
    if (id === CORRUPT_STATE_KEY || !record(entry) || entry.tracing !== "metadata") continue;
    policies[id] = {
      turns: {},
      turn_count:
        typeof entry.turn_count === "number" && Number.isInteger(entry.turn_count)
          ? Math.max(0, entry.turn_count)
          : 0,
      updated: typeof entry.updated === "string" ? entry.updated : "",
      tracing: "metadata",
    };
  }
  return policies;
}

function record(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function validUsage(value: unknown): boolean {
  if (value === undefined) return true;
  if (!record(value)) return false;
  return Object.values(value).every((entry) => entry === undefined || typeof entry === "number");
}

function validTool(value: unknown): boolean {
  if (!record(value)) return false;
  return (
    typeof value.tool_use_id === "string" &&
    typeof value.name === "string" &&
    record(value.input) &&
    typeof value.endMs === "number" &&
    (value.failed === undefined || typeof value.failed === "boolean") &&
    (value.error === undefined || typeof value.error === "string") &&
    (value.failure_type === undefined || typeof value.failure_type === "string") &&
    (value.duration === undefined || typeof value.duration === "number")
  );
}

function validSubagent(value: unknown): boolean {
  if (!record(value)) return false;
  return (
    typeof value.subagent_id === "string" &&
    typeof value.subagent_type === "string" &&
    typeof value.task === "string" &&
    typeof value.startMs === "number" &&
    (value.endMs === undefined || typeof value.endMs === "number") &&
    (value.tools === undefined || (Array.isArray(value.tools) && value.tools.every(validTool)))
  );
}

function validTurn(value: unknown): value is TurnBuffer {
  if (!record(value)) return false;
  return (
    typeof value.generation_id === "string" &&
    (value.tracing_mode === "full" || value.tracing_mode === "metadata") &&
    typeof value.startMs === "number" &&
    (value.endMs === undefined || typeof value.endMs === "number") &&
    Array.isArray(value.tools) &&
    value.tools.every(validTool) &&
    Array.isArray(value.thoughts) &&
    value.thoughts.every(
      (thought) =>
        record(thought) &&
        typeof thought.text === "string" &&
        (thought.duration_ms === undefined || typeof thought.duration_ms === "number"),
    ) &&
    Array.isArray(value.subagents) &&
    value.subagents.every(validSubagent) &&
    validUsage(value.usage) &&
    (value.prompt === undefined || typeof value.prompt === "string") &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.finalText === undefined || typeof value.finalText === "string") &&
    (value.status === undefined || typeof value.status === "string")
  );
}

function validConversation(value: unknown): value is ConversationState {
  if (!record(value) || !record(value.turns)) return false;
  return (
    Object.values(value.turns).every(validTurn) &&
    typeof value.turn_count === "number" &&
    Number.isInteger(value.turn_count) &&
    value.turn_count >= 0 &&
    typeof value.updated === "string" &&
    (value.tracing === undefined || value.tracing === "metadata") &&
    (value.parent_conversation_id === undefined ||
      typeof value.parent_conversation_id === "string") &&
    (value.parent_generation_id === undefined || typeof value.parent_generation_id === "string")
  );
}

function metadataStatus(status: string | undefined): "completed" | "error" | undefined {
  if (status == null) return undefined;
  return status === "completed" ? "completed" : "error";
}

export function sanitizeMetadataTurn(turn: TurnBuffer): TurnBuffer {
  turn.tracing_mode = "metadata";
  delete turn.prompt;
  delete turn.finalText;
  turn.status = metadataStatus(turn.status);
  turn.thoughts = [];
  turn.tools = turn.tools.map((tool) => ({
    tool_use_id: "",
    name: tool.name,
    input: {},
    failed: tool.failed ?? tool.error != null,
    duration: tool.duration,
    endMs: tool.endMs,
  }));
  turn.subagents = turn.subagents.map((subagent) => ({
    subagent_id: "",
    subagent_type: subagent.subagent_type,
    task: "",
    model: subagent.model,
    is_parallel_worker: subagent.is_parallel_worker,
    status: metadataStatus(subagent.status),
    duration_ms: subagent.duration_ms,
    message_count: subagent.message_count,
    tool_call_count: subagent.tool_call_count,
    loop_count: subagent.loop_count,
    startMs: subagent.startMs,
    endMs: subagent.endMs,
    tools: subagent.tools?.map((tool) => ({
      tool_use_id: "",
      name: tool.name,
      input: {},
      failed: tool.failed ?? tool.error != null,
      duration: tool.duration,
      endMs: tool.endMs,
    })),
  }));
  return turn;
}

export function enforceConversationTracing(conv: ConversationState): ConversationState {
  if (conv.tracing === "metadata") {
    for (const turn of Object.values(conv.turns)) sanitizeMetadataTurn(turn);
  }
  return conv;
}

export function loadState(stateFilePath: string): TracingState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(stateFilePath, "utf-8"));
  } catch {
    try {
      readFileSync(stateFilePath, "utf-8");
      return corruptState();
    } catch {
      return {};
    }
  }
  if (!record(parsed)) return corruptState();
  const state: TracingState = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (id === CORRUPT_STATE_KEY || !validConversation(value)) {
      return corruptState(stickyMetadataPolicies(parsed));
    }
    state[id] = enforceConversationTracing(value);
  }
  return state;
}

export function saveState(stateFilePath: string, state: TracingState): void {
  mkdirSync(dirname(stateFilePath), { recursive: true });
  const temp = `${stateFilePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temp, stateFilePath);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {}
    throw error;
  }
}

export function getConversationState(
  state: TracingState,
  conversationId: string,
): ConversationState {
  return state[conversationId] ?? { turns: {}, turn_count: 0, updated: "" };
}

export function newTurnBuffer(
  generationId: string,
  startMs: number,
  tracingMode: TracingMode = "full",
): TurnBuffer {
  return {
    generation_id: generationId,
    tracing_mode: tracingMode,
    startMs,
    tools: [],
    thoughts: [],
    subagents: [],
  };
}

export function getTurnBuffer(
  state: TracingState,
  conversationId: string,
  generationId: string,
): TurnBuffer | undefined {
  return state[conversationId]?.turns[generationId];
}

const CONVERSATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function pruneOldConversations(state: TracingState, now: number = Date.now()): TracingState {
  const cutoff = now - CONVERSATION_MAX_AGE_MS;
  const pruned: TracingState = {};
  for (const [conversationId, conv] of Object.entries(state)) {
    if (conversationId === CORRUPT_STATE_KEY) {
      pruned[conversationId] = conv;
      continue;
    }
    const updatedMs = conv.updated ? new Date(conv.updated).getTime() : 0;
    if (updatedMs >= cutoff || conv.tracing === "metadata") {
      pruned[conversationId] =
        updatedMs >= cutoff ? conv : { ...conv, turns: {}, updated: new Date(now).toISOString() };
    }
  }
  return pruned;
}
