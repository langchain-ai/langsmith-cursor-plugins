import type { TurnBuffer, TurnOrigin } from "./types.js";

export type UploadJobKind = "stop" | "sweep";

export interface UploadJobContext {
  kind: UploadJobKind;
  conversationId: string;
  turnNum: number;
  buffer: TurnBuffer;
  origin: TurnOrigin;
  savedAtMs?: number;
  outputEventIds?: string[];
}

export interface QueuedJobRef {
  conversationId: string;
  generationId: string;
  savedAtMs: number;
}
