#!/usr/bin/env node
/**
 * postToolUse hook — appends a completed tool call to the current turn buffer.
 */

import { readStdin } from "../utils/stdin.js";
import { initHook } from "../utils/hook-init.js";
import { atomicUpdateState } from "../state.js";
import { reducePostToolUse } from "../reducer.js";
import { error, debug } from "../logger.js";
import type { PostToolUseInput } from "../types.js";

async function main(): Promise<void> {
  const input = await readStdin<PostToolUseInput>();
  const config = initHook(input.workspace_roots?.[0]);
  if (!config) return;

  debug(`postToolUse ${input.tool_name} conv=${input.conversation_id} gen=${input.generation_id}`);
  await atomicUpdateState(config.stateFilePath, (s) => reducePostToolUse(s, input, Date.now()));
}

main().catch((err) => {
  try {
    error(`postToolUse hook error: ${err}`);
  } catch {
    /* last resort */
  }
  // Non-zero exit (never 2 = "block") tells Cursor the hook failed.
  process.exit(1);
});
