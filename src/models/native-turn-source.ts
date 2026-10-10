import type { TurnBuffer } from "../types.js";

export interface CursorNativeTurnSource {
  version: 1;
  sourceEventId: string;
  conversationId: string;
  turnNum: number;
  buffer: TurnBuffer;
}

export interface CursorNativeTurnRoute {
  version: 1;
  cwd: string;
}

export interface CursorNativeTurnSourceInput {
  storageRoot: string;
  accountFingerprint: string;
  sessionId: string;
  conversationId: string;
  sourceEventId: string;
  turnNum: number;
  buffer: TurnBuffer;
  cwd: string;
}

export interface CursorNativeTurnSourceResult {
  sourceRef: string;
  source: CursorNativeTurnSource;
  route: CursorNativeTurnRoute;
}
