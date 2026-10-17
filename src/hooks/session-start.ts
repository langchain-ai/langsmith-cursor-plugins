/**
 * sessionStart hook — best-effort housekeeping: prunes stale conversation state,
 * then uploads any turn another session left buffered with no stop.
 */

import { readStdin } from "../utils/stdin.js";
import { initHook } from "../utils/hook-init.js";
import { wakeUploader } from "../tracing-engine.js";
import { debug } from "../logger.js";
import type { SessionStartInput } from "../models/types.js";

export async function run(): Promise<void> {
  const input = await readStdin<SessionStartInput>();
  const config = initHook(input.workspace_roots?.[0]);
  if (!config) return;

  debug(`sessionStart conv=${input.conversation_id}`);
  await wakeUploader(config, input.conversation_id);
}
