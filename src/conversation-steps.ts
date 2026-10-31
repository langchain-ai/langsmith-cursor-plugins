/**
 * Recover a turn's interleaved step sequence from Cursor's DB protobuf. Best-effort,
 * never throws. Shallow decode (order + text + tool_use_id); tool I/O joins from hooks.
 */

import { existsSync } from "node:fs";
import type { HookOutput } from "@langchain/plugins-base/tracing";
import { isRecord } from "./normalize.js";
import { defaultCursorDbPath } from "./attachments.js";
import { decodeConversationStateBlob } from "./system-prompt.js";
import { openDbReader } from "./cursor-db.js";
import {
  AGENT_STEPS_FIELD,
  HOOK_CONTEXT_NAME_FIELD,
  HOOK_CONTEXT_TEXT_FIELD,
  HOOK_EVENT_PLACEMENT,
  MESSAGE_TEXT_FIELD,
  STATE_TURNS_FIELD,
  STEP_ASSISTANT_FIELD,
  STEP_THINKING_FIELD,
  STEP_TOOL_FIELD,
  THINKING_DURATION_FIELD,
  TOOLCALL_HOOK_CONTEXTS_FIELD,
  TOOLCALL_TOOL_USE_ID_FIELD,
  TOOL_FIELD_NAMES,
  TURN_AGENT_FIELD,
  TURN_USER_MESSAGE_FIELD,
  UNKNOWN_HOOK_PLACEMENT,
  USER_MESSAGE_HOOK_CONTEXTS_FIELD,
  USER_MESSAGE_ID_FIELD,
} from "./conversation-steps-constants.js";
import type { BlobReader } from "./models/cursor-db.js";
import type {
  HookPlacement,
  ResolveTurnHooksOptions,
  ResolveTurnStepsOptions,
  Round,
  RunHooks,
  Step,
  TurnHooks,
  WireField,
} from "./models/conversation-steps.js";
import * as logger from "./logger.js";

// ─── Generic wire-format scanner (dependency-free) ────────────────────────────

/** Scan one message's top-level fields. Returns [] (not throws) on malformed input. */
export function scanFields(buf: Buffer): WireField[] {
  const out: WireField[] = [];
  let p = 0;
  const readVarint = (): number => {
    let result = 0;
    let shift = 1; // 2^(7*n) — multiply (not <<) to stay exact past 32 bits
    let byte: number;
    do {
      byte = buf[p++];
      result += (byte & 0x7f) * shift;
      shift *= 128;
    } while (byte & 0x80 && p < buf.length);
    return result;
  };
  while (p < buf.length) {
    const tag = readVarint();
    const field = tag >>> 3;
    const wire = tag & 0x7;
    if (field === 0) return out; // invalid field number — stop
    switch (wire) {
      case 0: // varint
        out.push({ field, num: readVarint() });
        break;
      case 1: // 64-bit
        p += 8;
        break;
      case 2: {
        // length-delimited
        const len = readVarint();
        if (len < 0 || p + len > buf.length) return out;
        out.push({ field, bytes: buf.subarray(p, p + len) });
        p += len;
        break;
      }
      case 5: // 32-bit
        p += 4;
        break;
      default: // unknown wire type (e.g. groups) — stop, return what we have
        return out;
    }
  }
  return out;
}

/** First length-delimited value for `field`, if any. */
function firstBytes(buf: Buffer, field: number): Buffer | undefined {
  for (const f of scanFields(buf)) if (f.field === field && f.bytes) return f.bytes;
  return undefined;
}

/** All length-delimited values for `field`. */
function allBytes(buf: Buffer, field: number): Buffer[] {
  const out: Buffer[] = [];
  for (const f of scanFields(buf)) if (f.field === field && f.bytes) out.push(f.bytes);
  return out;
}

/** First varint value for `field`, if any. */
function firstVarint(buf: Buffer, field: number): number | undefined {
  for (const f of scanFields(buf)) if (f.field === field && f.num != null) return f.num;
  return undefined;
}

// ─── Step decoding ────────────────────────────────────────────────────────────

/** Decode a single ConversationStep blob into a typed Step, or undefined if unrecognized. */
export function decodeStep(buf: Buffer): Step | undefined {
  const thinking = firstBytes(buf, STEP_THINKING_FIELD);
  if (thinking) {
    const text = firstBytes(thinking, MESSAGE_TEXT_FIELD)?.toString("utf-8");
    const durationMs = firstVarint(thinking, THINKING_DURATION_FIELD);
    return { kind: "thinking", text, durationMs };
  }
  const tool = firstBytes(buf, STEP_TOOL_FIELD);
  if (tool) {
    const toolUseId = firstBytes(tool, TOOLCALL_TOOL_USE_ID_FIELD)?.toString("utf-8");
    // The tool oneof field is the first field that isn't the tool_use_id or hook contexts.
    let toolField: number | undefined;
    for (const f of scanFields(tool)) {
      if (f.field === TOOLCALL_TOOL_USE_ID_FIELD || f.field === TOOLCALL_HOOK_CONTEXTS_FIELD) {
        continue;
      }
      toolField = f.field;
      break;
    }
    return {
      kind: "tool",
      toolUseId,
      toolField,
      toolName: toolField != null ? TOOL_FIELD_NAMES[toolField] : undefined,
    };
  }
  const assistant = firstBytes(buf, STEP_ASSISTANT_FIELD);
  if (assistant) {
    return {
      kind: "assistant",
      text: firstBytes(assistant, MESSAGE_TEXT_FIELD)?.toString("utf-8"),
    };
  }
  return undefined;
}

// ─── Round grouping (pure, testable) ──────────────────────────────────────────

/** Group steps into rounds (a text step after a tool starts a new round). */
export function groupSteps(steps: Step[]): Round[] {
  const rounds: Round[] = [];
  let current: Round | undefined;
  const newRound = (): Round => {
    const r: Round = { thinking: [], toolSteps: [] };
    rounds.push(r);
    return r;
  };
  for (const step of steps) {
    if (step.kind === "tool") {
      if (!current) current = newRound();
      current.toolSteps.push({
        toolUseId: step.toolUseId,
        toolField: step.toolField,
        toolName: step.toolName,
      });
      continue;
    }
    // thinking / assistant — start a new round if the current one already emitted tools.
    if (!current || current.toolSteps.length > 0) current = newRound();
    if (step.kind === "thinking") {
      current.thinking.push({ text: step.text, durationMs: step.durationMs });
    } else {
      current.assistantText = current.assistantText
        ? `${current.assistantText}\n${step.text ?? ""}`
        : step.text;
    }
  }
  return rounds;
}

// ─── DB reader (injectable for tests) ─────────────────────────────────────────

const agentKvKey = (blobId: Buffer): string => `agentKv:blob:${blobId.toString("hex")}`;

function conversationTurnIds(reader: BlobReader, conversationId: string): Buffer[] | undefined {
  const composer = reader.get(`composerData:${conversationId}`);
  if (!composer) return undefined;
  const parsed: unknown = JSON.parse(composer.toString("utf-8"));
  const blob = decodeConversationStateBlob(isRecord(parsed) ? parsed.conversationState : undefined);
  if (!blob) return undefined;
  return allBytes(blob, STATE_TURNS_FIELD);
}

/** Decode the ordered steps of one turn blob. Returns undefined for non-agent (e.g. shell) turns. */
function decodeTurnSteps(reader: BlobReader, turnBlobId: Buffer): Step[] | undefined {
  const turnBlob = reader.get(agentKvKey(turnBlobId));
  if (!turnBlob) return undefined;
  const agent = firstBytes(turnBlob, TURN_AGENT_FIELD);
  if (!agent) return undefined; // shell turn or unknown oneof case
  const steps: Step[] = [];
  for (const stepId of allBytes(agent, AGENT_STEPS_FIELD)) {
    const stepBlob = reader.get(agentKvKey(stepId));
    if (!stepBlob) continue;
    const step = decodeStep(stepBlob);
    if (step) steps.push(step);
  }
  return steps;
}

/** Resolve the current turn's steps by tool_use_id overlap. Undefined → caller falls back. */
export function resolveTurnSteps(opts: ResolveTurnStepsOptions): Step[] | undefined {
  const wanted = new Set(opts.toolUseIds.filter(Boolean));
  if (wanted.size === 0) return undefined; // nothing to anchor on — keep current shape
  try {
    const dbPath = opts.dbPath ?? defaultCursorDbPath();
    if (!existsSync(dbPath)) {
      logger.debug(`conversation-steps: no Cursor DB at ${dbPath}`);
      return undefined;
    }
    const reader = (opts.openReader ?? openDbReader)(dbPath);
    try {
      const turnIds = conversationTurnIds(reader, opts.conversationId);
      if (!turnIds) return undefined;
      // Newest-first: the current turn is almost always the last one flushed.
      for (let i = turnIds.length - 1; i >= 0; i--) {
        const steps = decodeTurnSteps(reader, turnIds[i]);
        if (!steps) continue;
        const overlap = steps.some(
          (s) => s.kind === "tool" && s.toolUseId && wanted.has(s.toolUseId),
        );
        if (overlap) {
          logger.log(
            `conversation-steps: recovered ${steps.length} step(s) for ${opts.conversationId}`,
          );
          return steps;
        }
      }
      logger.debug(`conversation-steps: no turn matched buffered tools for ${opts.conversationId}`);
      return undefined;
    } finally {
      reader.close();
    }
  } catch (err) {
    logger.warn(
      `conversation-steps: resolution failed for ${opts.conversationId}, skipping (${err})`,
    );
    return undefined;
  }
}

function readHooks(entries: Buffer[]): HookOutput[] {
  return entries.flatMap((entry) => {
    const name = firstBytes(entry, HOOK_CONTEXT_NAME_FIELD)?.toString("utf-8");
    const output = firstBytes(entry, HOOK_CONTEXT_TEXT_FIELD)?.toString("utf-8");
    return name && output ? [{ name, output }] : [];
  });
}

function turnAgent(reader: BlobReader, turnBlobId: Buffer): Buffer | undefined {
  const turnBlob = reader.get(agentKvKey(turnBlobId));
  return turnBlob && firstBytes(turnBlob, TURN_AGENT_FIELD);
}

function agentToolCalls(reader: BlobReader, agent: Buffer): Buffer[] {
  return allBytes(agent, AGENT_STEPS_FIELD).flatMap((stepId) => {
    const step = reader.get(agentKvKey(stepId));
    const tool = step && firstBytes(step, STEP_TOOL_FIELD);
    return tool ? [tool] : [];
  });
}

const toolCallId = (tool: Buffer): string | undefined =>
  firstBytes(tool, TOOLCALL_TOOL_USE_ID_FIELD)?.toString("utf-8") || undefined;

function matchedTurnHooks(
  reader: BlobReader,
  turnBlobId: Buffer,
  opts: ResolveTurnHooksOptions,
): TurnHooks | undefined {
  const agent = turnAgent(reader, turnBlobId);
  if (!agent) return undefined;
  const userBlobId = firstBytes(agent, TURN_USER_MESSAGE_FIELD);
  const user = userBlobId && reader.get(agentKvKey(userBlobId));
  if (!user || firstBytes(user, USER_MESSAGE_ID_FIELD)?.toString("utf-8") !== opts.generationId) {
    return undefined;
  }

  const hooks: TurnHooks = { inputs: [], outputs: [], tools: new Map() };
  placeHooks(hooks, readHooks(allBytes(user, USER_MESSAGE_HOOK_CONTEXTS_FIELD)));
  const tools = agentToolCalls(reader, agent);
  const idless = tools.filter((tool) => !toolCallId(tool));
  for (const tool of tools) {
    const toolUseId = toolCallId(tool) ?? (idless.length === 1 ? opts.idlessToolId : undefined);
    if (toolUseId)
      placeHooks(hooks, readHooks(allBytes(tool, TOOLCALL_HOOK_CONTEXTS_FIELD)), toolUseId);
  }
  return hooks;
}

function addSubagentToolHooks(
  reader: BlobReader,
  hooks: TurnHooks,
  conversationId: string,
  wanted: Set<string>,
): void {
  const turnIds = conversationTurnIds(reader, conversationId) ?? [];
  for (let i = turnIds.length - 1; i >= 0 && wanted.size > 0; i--) {
    const agent = turnAgent(reader, turnIds[i]);
    for (const tool of agent ? agentToolCalls(reader, agent) : []) {
      const toolUseId = toolCallId(tool);
      if (!toolUseId || !wanted.delete(toolUseId)) continue;
      const entries = readHooks(allBytes(tool, TOOLCALL_HOOK_CONTEXTS_FIELD));
      const toolScoped = entries.filter((hook) => hookPlacement(hook).scope === "tool");
      placeHooks(hooks, toolScoped, toolUseId);
    }
  }
}

const hookPlacement = (hook: HookOutput): HookPlacement =>
  HOOK_EVENT_PLACEMENT.get(hook.name) ?? UNKNOWN_HOOK_PLACEMENT;

function placeHooks(hooks: TurnHooks, entries: HookOutput[], toolUseId?: string): void {
  for (const hook of entries) {
    const { direction, scope } = hookPlacement(hook);
    let run: RunHooks = hooks;
    if (scope === "tool" && toolUseId) {
      run = hooks.tools.get(toolUseId) ?? { inputs: [], outputs: [] };
      hooks.tools.set(toolUseId, run);
    }
    run[direction === "input" ? "inputs" : "outputs"].push(hook);
  }
}

export function resolveTurnHooks(opts: ResolveTurnHooksOptions): TurnHooks | undefined {
  try {
    const dbPath = opts.dbPath ?? defaultCursorDbPath();
    if (!existsSync(dbPath)) return undefined;
    const reader = openDbReader(dbPath);
    try {
      const turnIds = conversationTurnIds(reader, opts.conversationId) ?? [];
      let hooks: TurnHooks | undefined;
      for (let i = turnIds.length - 1; i >= 0 && !hooks; i--) {
        hooks = matchedTurnHooks(reader, turnIds[i], opts);
      }
      for (const [childId, toolUseIds] of opts.subagentToolIds) {
        if (hooks) addSubagentToolHooks(reader, hooks, childId, new Set(toolUseIds));
      }
      return hooks;
    } finally {
      reader.close();
    }
  } catch (err) {
    logger.warn(`conversation-steps: hook resolution failed for ${opts.conversationId} (${err})`);
    return undefined;
  }
}
