#!/usr/bin/env node
/**
 * afterAgentResponse hook — records the final assistant text and per-turn usage.
 */

import { readStdin } from "../utils/stdin.js";
import { initHook } from "../utils/hook-init.js";
import { atomicUpdateState } from "../state.js";
import { reduceAfterAgentResponse } from "../reducer.js";
import { error, debug } from "../logger.js";
import type { AfterAgentResponseInput } from "../types.js";

async function main(): Promise<void> {
  const input = await readStdin<AfterAgentResponseInput>();
  const config = initHook(input.workspace_roots?.[0]);
  if (!config) return;

  debug(`afterAgentResponse conv=${input.conversation_id} gen=${input.generation_id}`);
  await atomicUpdateState(config.stateFilePath, (s) =>
    reduceAfterAgentResponse(s, input, Date.now()),
  );
}

main().catch((err) => {
  try {
    error(`afterAgentResponse hook error: ${err}`);
  } catch {
    /* last resort */
  }
  // Non-zero exit (never 2 = "block") tells Cursor the hook failed.
  process.exit(1);
});
