import { runEngineWorker } from "../tracing-engine.js";
import { initHook } from "../utils/hook-init.js";

export async function run([cwd, sessionId]: readonly string[]): Promise<void> {
  const config = initHook(cwd);
  if (config && sessionId) await runEngineWorker(config, sessionId);
}
