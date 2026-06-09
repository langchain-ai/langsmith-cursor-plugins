#!/usr/bin/env node
/**
 * sessionStart hook — best-effort housekeeping: prune stale conversation state.
 * Also serves as a no-op touchpoint confirming hooks are wired.
 */

import { readStdin } from "../utils/stdin.js";
import { initHook } from "../utils/hook-init.js";
import { atomicUpdateState, pruneOldConversations } from "../state.js";
import { error, debug } from "../logger.js";
import type { SessionStartInput } from "../types.js";

async function main(): Promise<void> {
  const input = await readStdin<SessionStartInput>();
  const config = initHook(input.workspace_roots?.[0]);
  if (!config) return;

  debug(`sessionStart conv=${input.conversation_id}`);
  await atomicUpdateState(config.stateFilePath, (state) => pruneOldConversations(state));
}

main().catch((err) => {
  try {
    error(`sessionStart hook error: ${err}`);
  } catch {
    /* last resort */
  }
  process.exit(0);
});
