/**
 * Shared hook startup utilities.
 */

import { loadConfig } from "../config.js";
import type { Config } from "../models/config.js";
import { initLogger, error } from "../logger.js";
import { uploadCredential, uploadProblem } from "../writer-options.js";

/** Standard hook startup: load config, init logger, check enable + credential. */
export function initHook(cwd?: string): Config | null {
  const config = loadConfig({ cwd });
  initLogger(config.debug);

  if (!config.enabled) {
    return null;
  }

  const problem = uploadProblem(config, uploadCredential(config));
  if (problem !== undefined) {
    error(problem);
    return null;
  }

  return config;
}
