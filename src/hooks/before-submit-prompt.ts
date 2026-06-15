#!/usr/bin/env node
/**
 * beforeSubmitPrompt hook — opens a new turn buffer for this generation.
 */

import { readStdin } from "../utils/stdin.js";
import { initHook } from "../utils/hook-init.js";
import { atomicUpdateState } from "../state.js";
import { reduceBeforeSubmitPrompt } from "../reducer.js";
import { error, debug } from "../logger.js";
import type { BeforeSubmitPromptInput } from "../types.js";

async function main(): Promise<void> {
  const input = await readStdin<BeforeSubmitPromptInput>();
  const config = initHook(input.workspace_roots?.[0]);
  if (!config) return;

  debug(`beforeSubmitPrompt conv=${input.conversation_id} gen=${input.generation_id}`);
  await atomicUpdateState(config.stateFilePath, (s) =>
    reduceBeforeSubmitPrompt(s, input, Date.now()),
  );
}

main().catch((err) => {
  try {
    error(`beforeSubmitPrompt hook error: ${err}`);
  } catch {
    /* last resort */
  }
  // Non-zero exit (never 2 = "block") tells Cursor the hook failed.
  process.exit(1);
});
