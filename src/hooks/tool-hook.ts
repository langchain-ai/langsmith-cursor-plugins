import type { HookRunner } from "@langchain/plugins-base/plugin";
import type { LiveTool, StateHookOptions } from "../models/hooks.js";
import { debug } from "../logger.js";
import { atomicUpdateState, getTurnBuffer, ownEntry } from "../state.js";
import { saveToolForUpload } from "../tracing-engine.js";
import { originFromConfig } from "../turn-origin.js";
import type { HookInputBase, TracingState } from "../models/types.js";
import { initHook } from "../utils/hook-init.js";
import { readStdin } from "../utils/stdin.js";

export function toolHook<Input extends HookInputBase>({
  describe,
  reduce,
}: StateHookOptions<Input>): HookRunner {
  return async () => {
    const input = await readStdin<Input>();
    const config = initHook(input.workspace_roots?.[0]);
    if (!config) return;

    debug(describe(input));
    let live: LiveTool | undefined;
    await atomicUpdateState(config.stateFilePath, (s) => {
      const next = reduce(s, input, Date.now());
      live = addedLiveTool(next, input);
      return next;
    });
    if (!live) return;
    const { buffer, turnNum, toolIndex } = live;

    await saveToolForUpload(config, {
      kind: "tool",
      conversationId: input.conversation_id,
      turnNum,
      buffer,
      origin: originFromConfig(config, input),
      toolIndex,
    });
  };
}

function addedLiveTool(state: TracingState, input: HookInputBase): LiveTool | undefined {
  const buffer = getTurnBuffer(state, input.conversation_id, input.generation_id);
  if (!buffer || buffer.turnNum === undefined) return undefined;
  if (buffer.tracingMode !== "full" && buffer.tracingMode !== "metadata") return undefined;
  const swept = ownEntry(state, input.conversation_id)?.sweepFinalizedGenerations;
  if (swept?.includes(input.generation_id)) return undefined;
  return { buffer, turnNum: buffer.turnNum, toolIndex: buffer.tools.length - 1 };
}
