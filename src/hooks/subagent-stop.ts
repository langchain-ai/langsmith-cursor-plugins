#!/usr/bin/env node
/**
 * subagentStop hook — finalizes a buffered subagent with status + duration.
 */

import { readStdin } from "../utils/stdin.js";
import { initHook } from "../utils/hook-init.js";
import { atomicUpdateState } from "../state.js";
import { reduceSubagentStop } from "../reducer.js";
import { error, debug } from "../logger.js";
import type { SubagentStopInput } from "../types.js";

async function main(): Promise<void> {
  const input = await readStdin<SubagentStopInput>();
  const config = initHook(input.workspace_roots?.[0]);
  if (!config) return;

  debug(`subagentStop ${input.subagent_type} (${input.subagent_id})`);
  await atomicUpdateState(config.stateFilePath, (s) => reduceSubagentStop(s, input, Date.now()));
}

main().catch((err) => {
  try {
    error(`subagentStop hook error: ${err}`);
  } catch {
    /* last resort */
  }
  process.exit(0);
});
