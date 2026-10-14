import type { HookInputBase, TracingState } from "./types.js";

export interface StateHookOptions<Input extends HookInputBase> {
  describe: (input: Input) => string;
  reduce: (state: TracingState, input: Input, nowMs: number) => TracingState;
}
