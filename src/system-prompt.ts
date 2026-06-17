/**
 * Recover a turn's system prompt from Cursor's DB: composerData →
 * conversationState (protobuf field 1) → agentKv system message. Best-effort.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { isRecord } from "./normalize.js";
import { defaultCursorDbPath } from "./attachments.js";
import * as logger from "./logger.js";

/** ConversationStateStructure.root_prompt_messages_json — repeated bytes, field 1. */
const ROOT_PROMPT_MESSAGES_FIELD = 1;

// ─── Wire-format reader (only what field-1 extraction needs) ─────────────────

interface Cursor {
  p: number;
}

/** Read a base-128 varint, advancing the cursor. Multiplies (not <<) to stay exact past 32 bits. */
function readVarint(buf: Buffer, c: Cursor): number {
  let result = 0;
  let shift = 1; // 2^(7*n)
  let byte: number;
  do {
    byte = buf[c.p++];
    result += (byte & 0x7f) * shift;
    shift *= 128;
  } while (byte & 0x80 && c.p < buf.length);
  return result;
}

/** Advance the cursor past a varint without decoding its value. */
function skipVarint(buf: Buffer, c: Cursor): void {
  while (c.p < buf.length && buf[c.p++] & 0x80);
}

/** Collect top-level length-delimited (wire type 2) values for `field`; [] if malformed. */
export function readProtoLenField(buf: Buffer, field: number): Buffer[] {
  const out: Buffer[] = [];
  const c: Cursor = { p: 0 };
  while (c.p < buf.length) {
    const tag = readVarint(buf, c);
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;
    switch (wireType) {
      case 0: // varint
        skipVarint(buf, c);
        break;
      case 1: // 64-bit
        c.p += 8;
        break;
      case 2: {
        // length-delimited
        const len = readVarint(buf, c);
        if (len < 0 || c.p + len > buf.length) return out;
        if (fieldNumber === field) out.push(buf.subarray(c.p, c.p + len));
        c.p += len;
        break;
      }
      case 5: // 32-bit
        c.p += 4;
        break;
      default: // unknown wire type (e.g. deprecated groups) — stop, return what we have
        return out;
    }
  }
  return out;
}

// ─── Blob decoding + system-message extraction ───────────────────────────────

/** Decode a composerData.conversationState value: "~"-prefixed base64, else hex. */
export function decodeConversationStateBlob(raw: unknown): Buffer | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const buf = raw.startsWith("~")
    ? Buffer.from(raw.slice(1), "base64")
    : Buffer.from(raw, "hex");
  return buf.length > 0 ? buf : undefined;
}

/** If a root-prompt-message blob is the system message, return its content as text. */
export function systemContentOf(buf: Buffer): string | undefined {
  let msg: unknown;
  try {
    msg = JSON.parse(buf.toString("utf-8"));
  } catch {
    return undefined;
  }
  if (!isRecord(msg) || msg.role !== "system") return undefined;
  const content = msg.content;
  if (typeof content === "string") return content || undefined;
  if (content == null) return undefined;
  return JSON.stringify(content); // array-of-parts form — keep the bytes
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

export interface ResolveSystemPromptOptions {
  conversationId: string;
  /** Override the DB path; defaults to the platform Cursor globalStorage DB. */
  dbPath?: string;
  /** Injectable reader factory (tests). Defaults to the read-only `node:sqlite` reader. */
  openReader?: (dbPath: string) => BlobReader;
}

/** Resolve a conversation's system prompt from Cursor's DB. Best-effort; never throws. */
export function resolveTurnSystemPrompt(opts: ResolveSystemPromptOptions): string | undefined {
  try {
    const dbPath = opts.dbPath ?? defaultCursorDbPath();
    if (!existsSync(dbPath)) {
      logger.debug(`system-prompt: no Cursor DB at ${dbPath}`);
      return undefined;
    }
    const reader = (opts.openReader ?? openDbReader)(dbPath);
    try {
      const composer = reader.get(`composerData:${opts.conversationId}`);
      if (!composer) return undefined;

      const parsed = JSON.parse(composer.toString("utf-8"));
      const blob = decodeConversationStateBlob(isRecord(parsed) ? parsed.conversationState : undefined);
      if (!blob) return undefined;

      const blobIds = readProtoLenField(blob, ROOT_PROMPT_MESSAGES_FIELD);
      for (const id of blobIds) {
        const msg = reader.get(`agentKv:blob:${id.toString("hex")}`);
        if (!msg) continue;
        const system = systemContentOf(msg);
        if (system) {
          logger.log(`system-prompt: recovered (${system.length} chars)`);
          return system;
        }
      }
      return undefined;
    } finally {
      reader.close();
    }
  } catch (err) {
    logger.warn(`system-prompt: resolution failed, skipping (${err})`);
    return undefined;
  }
}
