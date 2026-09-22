#!/usr/bin/env node
/**
 * sessionStart hook — best-effort housekeeping: prunes stale conversation state,
 * then uploads any turn another session left buffered with no stop.
 */

import { readStdin } from "../utils/stdin.js";
import { initHook } from "../utils/hook-init.js";
import { pruneOldConversations } from "../state.js";
import { runSweep } from "../sweep.js";
import { error, debug } from "../logger.js";
import type { SessionStartInput } from "../types.js";

async function main(): Promise<void> {
  const input = await readStdin<SessionStartInput>();
  const config = initHook(input.workspace_roots?.[0]);
  if (!config) return;

  debug(`sessionStart conv=${input.conversation_id}`);
  await runSweep({ config, input, apply: (state) => pruneOldConversations(state) });
}

export const finished = main().catch((err) => {
  try {
    error(`sessionStart hook error: ${err}`);
  } catch {
    /* last resort */
  }
  // Non-zero exit (never 2 = "block") tells Cursor the hook failed.
  process.exit(1);
});
