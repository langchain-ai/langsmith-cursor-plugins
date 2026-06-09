/**
 * Shared hook startup utilities.
 */

import { loadConfig, type Config } from "../config.js";
import { initLogger, error } from "../logger.js";

/**
 * Standard hook startup: load config, init logger, check enable-switch and API key.
 * Returns the Config if tracing should proceed, null if the hook should exit early.
 *
 * Tracing is enabled when `enabled: true` is set in a langsmith.json config file
 * (~/.cursor/langsmith.json or ./.cursor/langsmith.json) or via the
 * TRACE_TO_LANGSMITH=true environment variable.
 */
export function initHook(cwd?: string): Config | null {
  const config = loadConfig({ cwd });
  initLogger(config.debug);

  if (!config.enabled) {
    return null;
  }

  if (!config.apiKey && (!config.replicas || config.replicas.length === 0)) {
    error(
      "Tracing enabled but no API key set (langsmith.json api_key, CURSOR_LANGSMITH_API_KEY, or LANGSMITH_API_KEY) and no replicas configured",
    );
    return null;
  }

  return config;
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(path: string | undefined): string | undefined {
  return path?.replace(/^~/, process.env.HOME ?? "");
}
