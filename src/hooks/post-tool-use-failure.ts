#!/usr/bin/env node
/**
 * postToolUseFailure hook — appends a failed tool call to the current turn buffer.
 */

import { readStdin } from "../utils/stdin.js";
import { initHook } from "../utils/hook-init.js";
import { atomicUpdateState } from "../state.js";
import { reducePostToolUseFailure } from "../reducer.js";
import { error, debug } from "../logger.js";
import type { PostToolUseFailureInput } from "../types.js";

async function main(): Promise<void> {
  const input = await readStdin<PostToolUseFailureInput>();
  const config = initHook(input.workspace_roots?.[0]);
  if (!config) return;

  debug(`postToolUseFailure ${input.tool_name} conv=${input.conversation_id}`);
  await atomicUpdateState(config.stateFilePath, (s) =>
    reducePostToolUseFailure(s, input, Date.now()),
  );
}

main().catch((err) => {
  try {
    error(`postToolUseFailure hook error: ${err}`);
  } catch {
    /* last resort */
  }
  // Non-zero exit (never 2 = "block") tells Cursor the hook failed.
  process.exit(1);
});
