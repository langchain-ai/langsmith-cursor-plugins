#!/usr/bin/env node
/**
 * stop hook — finalizes the current turn (one generation): merges final usage,
 * builds and posts the LangSmith trace, flushes, and clears the turn buffer.
 *
 * Idempotent: one stop = one turn. No buffer for this generation → no-op.
 */

import { readStdin } from "../utils/stdin.js";
import { initHook } from "../utils/hook-init.js";
import { atomicUpdateState } from "../state.js";
import { reduceStop } from "../reducer.js";
import { initTracing, buildTurnRuns, flushPendingTraces } from "../langsmith.js";
import { error, debug, warn } from "../logger.js";
import type { StopInput, TurnBuffer } from "../types.js";

async function main(): Promise<void> {
  const input = await readStdin<StopInput>();
  const config = initHook(input.workspace_roots?.[0]);
  if (!config) return;

  debug(`stop conv=${input.conversation_id} gen=${input.generation_id} status=${input.status}`);
  initTracing(config.apiKey, config.apiUrl, config.replicas);

  let toTrace: TurnBuffer | undefined;
  let turnNum = 0;

  await atomicUpdateState(config.stateFilePath, (s) => {
    const r = reduceStop(s, input, Date.now());
    toTrace = r.buffer;
    turnNum = r.turnNum;
    return r.state;
  });

  if (!toTrace) {
    debug("No buffered turn for this generation — nothing to trace");
    return;
  }

  try {
    await buildTurnRuns({
      buffer: toTrace,
      conversationId: input.conversation_id,
      turnNum,
      project: config.project,
      userEmail: input.user_email,
      workspaceRoots: input.workspace_roots,
      customMetadata: config.customMetadata,
    });
  } catch (err) {
    error(`Failed to build turn runs: ${err}`);
  }

  await flushPendingTraces();
}

main().catch((err) => {
  try {
    warn(`stop hook error: ${err}`);
  } catch {
    /* last resort */
  }
  process.exit(0);
});
