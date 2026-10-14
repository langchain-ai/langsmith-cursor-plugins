import type { BlobReader } from "./cursor-db.js";

/** A decoded top-level protobuf field. `num` = varint value; `bytes` = wire-type-2 payload. */
export interface WireField {
  field: number;
  num?: number;
  bytes?: Buffer;
}

export type Step =
  | { kind: "assistant"; text?: string }
  | { kind: "thinking"; text?: string; durationMs?: number }
  | { kind: "tool"; toolUseId?: string; toolField?: number; toolName?: string };

export interface Round {
  thinking: Array<{ text?: string; durationMs?: number }>;
  assistantText?: string;
  /** Tool steps emitted in this round, in order. */
  toolSteps: Array<{ toolUseId?: string; toolField?: number; toolName?: string }>;
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
