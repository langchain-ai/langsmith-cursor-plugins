#!/usr/bin/env node
/**
 * subagentStop hook — finalizes a buffered subagent with status + duration.
 */

import { readStdin } from "../utils/stdin.js";
import { initHook } from "../utils/hook-init.js";
import { atomicUpdateState } from "../state.js";
import { reduceSubagentStop } from "../reducer.js";
import { resolveSubagentTranscript } from "../subagent-transcript.js";
import { error, debug } from "../logger.js";
import type { SubagentStopInput } from "../types.js";

async function main(): Promise<void> {
  const input = await readStdin<SubagentStopInput>();
  const config = initHook(input.workspace_roots?.[0]);
  if (!config) return;

  debug(`subagentStop ${input.subagent_type} (${input.subagent_id})`);

  // Best-effort: recover the subagent's child conversation id (to splice in its
  // rich buffered tool events) and final answer from its on-disk transcript.
  // The reducer falls back to temporal linking if this returns undefined.
  const resolved = resolveSubagentTranscript(input.transcript_path, input.task);
  if (resolved) {
    debug(
      `resolved subagent transcript: child=${resolved.childConversationId}, ${resolved.toolCalls.length} tool call(s)`,
    );
  }

  await atomicUpdateState(config.stateFilePath, (s) =>
    reduceSubagentStop(s, input, Date.now(), resolved),
  );
}

main().catch((err) => {
  try {
    error(`subagentStop hook error: ${err}`);
  } catch {
    /* last resort */
  }
  process.exit(0);
});
