/**
 * Recover a turn's interleaved step sequence from Cursor's DB protobuf. Best-effort,
 * never throws. Shallow decode (order + text + tool_use_id); tool I/O joins from hooks.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { isRecord } from "./normalize.js";
import { defaultCursorDbPath } from "./attachments.js";
import { decodeConversationStateBlob } from "./system-prompt.js";
import * as logger from "./logger.js";

// ─── Protobuf field numbers (wire-stable; verified against Cursor 3.7.19) ─────

/** ConversationStateStructure.turns — repeated bytes (each = a turn blob id). */
const STATE_TURNS_FIELD = 8;
/** ConversationTurnStructure.agent_conversation_turn — oneof case 1. */
const TURN_AGENT_FIELD = 1;
/** AgentConversationTurnStructure.steps — repeated bytes (each = a step blob id). */
const AGENT_STEPS_FIELD = 2;
/** ConversationStep oneof: assistant_message=1, tool_call=2, thinking_message=3. */
const STEP_ASSISTANT_FIELD = 1;
const STEP_TOOL_FIELD = 2;
const STEP_THINKING_FIELD = 3;
/** AssistantMessage.text=1 / ThinkingMessage.text=1. */
const MESSAGE_TEXT_FIELD = 1;
/** ThinkingMessage.duration_ms=2. */
const THINKING_DURATION_FIELD = 2;
/** ToolCall.tool_use_id — string. Drift-added field, stable across all tool steps. */
const TOOLCALL_TOOL_USE_ID_FIELD = 57;
/** ToolCall.hook_additional_contexts=54 — not the tool oneof; skip when sniffing it. */
const TOOLCALL_HOOK_CONTEXTS_FIELD = 54;

/** ToolCall oneof field number → human-readable tool name (fallback labels only). */
const TOOL_FIELD_NAMES: Record<number, string> = {
  1: "Shell",
  3: "Delete",
  4: "Glob",
  5: "Grep",
  8: "Read",
  9: "UpdateTodos",
  10: "ReadTodos",
  12: "Edit",
  13: "Ls",
  14: "ReadLints",
  15: "MCP",
  16: "SemSearch",
  17: "CreatePlan",
  18: "WebSearch",
  19: "Task",
  20: "ListMcpResources",
  21: "ReadMcpResource",
  22: "ApplyAgentDiff",
  23: "AskQuestion",
  24: "Fetch",
  25: "SwitchMode",
  28: "GenerateImage",
  29: "RecordScreen",
  30: "ComputerUse",
  31: "WriteShellStdin",
  32: "Reflect",
  33: "SetupVmEnvironment",
  34: "Truncated",
  35: "StartGrindExecution",
  36: "StartGrindPlanning",
  37: "WebFetch",
  38: "ReportBugfixResults",
  39: "AiAttribution",
  40: "PrManagement",
  41: "McpAuth",
  42: "Await",
  43: "BlameByFilePath",
  44: "GetMcpTools",
  45: "ReportBug",
  46: "SetActiveBranch",
  48: "CommunicateUpdate",
  49: "SendFinalSummary",
  50: "UpdatePrCodeTour",
  51: "ReplaceEnv",
  52: "EditPrLabels",
  53: "RecordCiInvestigationFindings",
  55: "SendMessage",
  58: "SendToUser",
};

// ─── Generic wire-format scanner (dependency-free) ────────────────────────────

/** A decoded top-level protobuf field. `num` = varint value; `bytes` = wire-type-2 payload. */
interface WireField {
  field: number;
  num?: number;
  bytes?: Buffer;
}

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

export type Step =
  | { kind: "assistant"; text?: string }
  | { kind: "thinking"; text?: string; durationMs?: number }
  | { kind: "tool"; toolUseId?: string; toolField?: number; toolName?: string };

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

export interface Round {
  thinking: Array<{ text?: string; durationMs?: number }>;
  assistantText?: string;
  /** Tool steps emitted in this round, in order. */
  toolSteps: Array<{ toolUseId?: string; toolField?: number; toolName?: string }>;
}

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

/** A read-only key→bytes lookup over one DB connection. */
export interface BlobReader {
  get(key: string): Buffer | undefined;
  close(): void;
}

function openDbReader(dbPath: string): BlobReader {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const stmt = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
  return {
    get(key: string): Buffer | undefined {
      const row = stmt.get(key) as { value?: unknown } | undefined;
      const v = row?.value;
      if (typeof v === "string") return Buffer.from(v);
      if (v instanceof Uint8Array) return Buffer.from(v);
      return undefined;
    },
    close: () => db.close(),
  };
}

const agentKvKey = (blobId: Buffer): string => `agentKv:blob:${blobId.toString("hex")}`;

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

export interface ResolveTurnStepsOptions {
  conversationId: string;
  /** Hook-captured tool_use_ids for the current turn — used to pick the right turn. */
  toolUseIds: string[];
  /** Override the DB path; defaults to the platform Cursor globalStorage DB. */
  dbPath?: string;
  /** Injectable reader factory (tests). Defaults to the read-only `node:sqlite` reader. */
  openReader?: (dbPath: string) => BlobReader;
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
      const composer = reader.get(`composerData:${opts.conversationId}`);
      if (!composer) return undefined;
      const parsed: unknown = JSON.parse(composer.toString("utf-8"));
      const blob = decodeConversationStateBlob(
        isRecord(parsed) ? parsed.conversationState : undefined,
      );
      if (!blob) return undefined;

      const turnIds = allBytes(blob, STATE_TURNS_FIELD);
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
