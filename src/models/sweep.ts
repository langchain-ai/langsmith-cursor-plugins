import type { Config } from "./config.js";
import type { TracingState } from "./types.js";

export interface SweepOptions {
  config: Config;
  conversationId: string;
  nowMs?: number;
  apply?: (state: TracingState) => TracingState;
}
