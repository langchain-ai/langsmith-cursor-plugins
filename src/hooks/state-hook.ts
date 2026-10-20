import type { HookRunner } from "@langchain/plugins-base/plugin";
import type { StateHookOptions } from "../models/hooks.js";
import { debug } from "../logger.js";
import { atomicUpdateState } from "../state.js";
import type { HookInputBase } from "../models/types.js";
import { initHook } from "../utils/hook-init.js";
import { readStdin } from "../utils/stdin.js";

export function stateHook<Input extends HookInputBase>({
  describe,
  reduce,
}: StateHookOptions<Input>): HookRunner {
  return async () => {
    const input = await readStdin<Input>();
    const config = initHook(input.workspace_roots?.[0]);
    if (!config) return;

    debug(describe(input));
    await atomicUpdateState(config.stateFilePath, (s) => reduce(s, input, Date.now()));
  };
}
