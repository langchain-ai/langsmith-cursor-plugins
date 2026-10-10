#!/usr/bin/env node
/**
 * postToolUseFailure hook — appends a failed tool call to the current turn buffer.
 */

import { readStdin } from "../utils/stdin.js";
import { initHook } from "../utils/hook-init.js";
import { atomicUpdateState } from "../state.js";
import { reducePostToolUseFailure } from "../reducer.js";
import { captureEarlyCursorToolSource } from "../early-tool-capture.js";
import { error, debug } from "../logger.js";
import type { PostToolUseFailureInput } from "../types.js";

async function main(): Promise<void> {
  const input = await readStdin<PostToolUseFailureInput>();
  const config = initHook(input.workspace_roots?.[0]);
  if (!config) return;

  debug(`postToolUseFailure ${input.tool_name} conv=${input.conversation_id}`);
  const nowMs = Date.now();
  try {
    await captureEarlyCursorToolSource(config, input, nowMs);
  } catch (err) {
    error(`postToolUseFailure early capture failed: ${err}`);
  }
  await atomicUpdateState(config.stateFilePath, (s) => reducePostToolUseFailure(s, input, nowMs));
}

main().catch((err) => {
  try {
    error(`postToolUseFailure hook error: ${err}`);
  } catch {
    /* last resort */
  }
  process.exit(0);
});
