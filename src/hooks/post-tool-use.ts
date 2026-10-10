#!/usr/bin/env node
/**
 * postToolUse hook — appends a completed tool call to the current turn buffer.
 */

import { readStdin } from "../utils/stdin.js";
import { initHook } from "../utils/hook-init.js";
import { atomicUpdateState } from "../state.js";
import { reducePostToolUse } from "../reducer.js";
import { captureEarlyCursorToolSource } from "../early-tool-capture.js";
import { error, debug } from "../logger.js";
import type { PostToolUseInput } from "../types.js";

async function main(): Promise<void> {
  const input = await readStdin<PostToolUseInput>();
  const config = initHook(input.workspace_roots?.[0]);
  if (!config) return;

  debug(`postToolUse ${input.tool_name} conv=${input.conversation_id} gen=${input.generation_id}`);
  const nowMs = Date.now();
  try {
    await captureEarlyCursorToolSource(config, input, nowMs);
  } catch (err) {
    error(`postToolUse early capture failed: ${err}`);
  }
  await atomicUpdateState(config.stateFilePath, (s) => reducePostToolUse(s, input, nowMs));
}

export const finished = main().catch((err) => {
  try {
    error(`postToolUse hook error: ${err}`);
  } catch {
    /* last resort */
  }
  process.exit(0);
});
