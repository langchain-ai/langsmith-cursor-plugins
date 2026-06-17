#!/usr/bin/env node
/** subagentStart hook — records a subagent invocation on the parent turn buffer. */

import { readStdin } from "../utils/stdin.js";
import { initHook } from "../utils/hook-init.js";
import { atomicUpdateState } from "../state.js";
import { reduceSubagentStart } from "../reducer.js";
import { error, debug } from "../logger.js";
import type { SubagentStartInput } from "../types.js";

async function main(): Promise<void> {
  const input = await readStdin<SubagentStartInput>();
  const config = initHook(input.workspace_roots?.[0]);
  if (!config) return;

  debug(`subagentStart ${input.subagent_type} (${input.subagent_id})`);
  await atomicUpdateState(config.stateFilePath, (s) => reduceSubagentStart(s, input, Date.now()));
}

main().catch((err) => {
  try {
    error(`subagentStart hook error: ${err}`);
  } catch {
    /* last resort */
  }
  // Non-zero exit (never 2 = "block") tells Cursor the hook failed.
  process.exit(1);
});
