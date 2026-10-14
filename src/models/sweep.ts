import type { Client } from "langsmith";
import type { Config } from "./config.js";
import type { HookInputBase, TracingState } from "./types.js";

export interface SweepOptions {
  config: Config;
  input: HookInputBase;
  nowMs?: number;
  apply?: (state: TracingState) => TracingState;
  client?: Client;
}
