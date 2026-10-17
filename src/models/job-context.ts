import type { TurnBuffer, TurnOrigin } from "./types.js";

export type UploadJobKind = "stop" | "sweep" | "tool";

export interface UploadJobContext {
  kind: UploadJobKind;
  conversationId: string;
  turnNum: number;
  buffer: TurnBuffer;
  origin: TurnOrigin;
  savedAtMs?: number;
  outputEventIds?: string[];
  toolIndex?: number;
}

export interface QueuedJobRef {
  conversationId: string;
  generationId: string;
  savedAtMs: number;
}

export interface ToolJobRef {
  conversationId: string;
  generationId: string;
  toolIndex: number;
  toolUseId: string;
  model?: string;
  withRoot: boolean;
}
