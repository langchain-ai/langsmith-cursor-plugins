import { warn } from "../logger.js";
import { pruneOldConversations } from "../state.js";
import { runSweep } from "../sweep.js";
import { runEngineWorker } from "../tracing-engine.js";
import { initHook } from "../utils/hook-init.js";

export async function run([cwd, sessionId, project]: readonly string[]): Promise<void> {
  const config = initHook(cwd);
  if (!config || !sessionId) return;
  try {
    await runSweep({ config, conversationId: sessionId, apply: pruneOldConversations });
  } catch (err) {
    warn(`Could not sweep older turns: ${err}`);
  }
  await runEngineWorker(config, sessionId, project);
}
