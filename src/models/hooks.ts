import type { HookInputBase, TracingState, TurnBuffer } from "./types.js";

export interface StateHookOptions<Input extends HookInputBase> {
  describe: (input: Input) => string;
  reduce: (state: TracingState, input: Input, nowMs: number) => TracingState;
}

export interface LiveTool {
  buffer: TurnBuffer;
  turnNum: number;
  toolIndex: number;
}
