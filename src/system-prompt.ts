/**
 * Recover a turn's system prompt from Cursor's DB: composerData →
 * conversationState (protobuf field 1) → agentKv system message. Best-effort.
 */

import { existsSync } from "node:fs";
import { isRecord } from "./normalize.js";
import { defaultCursorDbPath } from "./attachments.js";
import { openDbReader } from "./cursor-db.js";
import { ROOT_PROMPT_MESSAGES_FIELD } from "./system-prompt-constants.js";
import type { BlobReader } from "./models/cursor-db.js";
import type { Cursor, ResolveSystemPromptsOptions } from "./models/system-prompt.js";
import * as logger from "./logger.js";

// ─── Wire-format reader (only what field-1 extraction needs) ─────────────────

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
  const buf = raw.startsWith("~") ? Buffer.from(raw.slice(1), "base64") : Buffer.from(raw, "hex");
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

/** Resolve one conversation's system prompt using an already-open reader. Never throws. */
function systemPromptFor(reader: BlobReader, conversationId: string): string | undefined {
  try {
    const composer = reader.get(`composerData:${conversationId}`);
    if (!composer) return undefined;

    const parsed = JSON.parse(composer.toString("utf-8"));
    const blob = decodeConversationStateBlob(
      isRecord(parsed) ? parsed.conversationState : undefined,
    );
    if (!blob) return undefined;

    for (const id of readProtoLenField(blob, ROOT_PROMPT_MESSAGES_FIELD)) {
      const msg = reader.get(`agentKv:blob:${id.toString("hex")}`);
      if (!msg) continue;
      const system = systemContentOf(msg);
      if (system) {
        logger.log(`system-prompt: recovered for ${conversationId} (${system.length} chars)`);
        return system;
      }
    }
    return undefined;
  } catch (err) {
    logger.warn(`system-prompt: resolution failed for ${conversationId}, skipping (${err})`);
    return undefined;
  }
}

/** Resolve system prompts for several conversations over one shared connection. */
export function resolveSystemPrompts(
  opts: ResolveSystemPromptsOptions,
): Map<string, string | undefined> {
  const result = new Map<string, string | undefined>();
  const ids = [...new Set(opts.conversationIds)].filter(Boolean);
  if (ids.length === 0) return result;
  try {
    const dbPath = opts.dbPath ?? defaultCursorDbPath();
    if (!existsSync(dbPath)) {
      logger.debug(`system-prompt: no Cursor DB at ${dbPath}`);
      return result;
    }
    const reader = (opts.openReader ?? openDbReader)(dbPath);
    try {
      for (const id of ids) {
        const system = systemPromptFor(reader, id);
        if (system) result.set(id, system);
      }
    } finally {
      reader.close();
    }
  } catch (err) {
    logger.warn(`system-prompt: resolution failed, skipping (${err})`);
  }
  return result;
}
