/**
 * Public API — re-exports for programmatic use and testing.
 */

export { loadConfig, parseRepoName, getRepoName } from "./config.js";
export type { Config } from "./config.js";

export {
  initTracing,
  buildTurnRuns,
  uploadTurn,
  flushPendingTraces,
  generateDottedOrderSegment,
  parseDottedOrder,
} from "./langsmith.js";

export {
  loadState,
  saveState,
  atomicUpdateState,
  getConversationState,
  getTurnBuffer,
  newTurnBuffer,
  nextTurnNum,
  pruneOldConversations,
} from "./state.js";

export {
  deriveModelInfo,
  stripModelSuffixes,
  preferModel,
  buildUsageMetadata,
  parseToolOutput,
  normalizeContentPart,
  normalizeContent,
  isRecord,
  canonicalModelId,
  CANONICAL_MODEL_MAP,
} from "./normalize.js";

export * from "./types.js";

export {
  reduceBeforeSubmitPrompt,
  reducePostToolUse,
  reducePostToolUseFailure,
  reduceAfterAgentResponse,
  reduceSubagentStart,
  reduceSubagentStop,
  reduceStop,
  reduceSweep,
  reduceUploadSettled,
} from "./reducer.js";
export type { SweepResult } from "./reducer.js";
export type { SweepClaim } from "./types.js";
export { MAX_UPLOAD_ATTEMPTS } from "./constants.js";

export { runSweep, sweepTracingMode } from "./sweep.js";
