/**
 * Public API — re-exports for programmatic use and testing.
 */

export { loadConfig, parseRepoName, getRepoName } from "./config.js";
export type { Config } from "./config.js";

export {
  initTracing,
  buildTurnRuns,
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
} from "./normalize.js";

export {
  canonicalModelId,
  lookupPricing,
  computeCosts,
  CANONICAL_MODEL_MAP,
  BUILTIN_PRICING,
} from "./pricing.js";
export type { ModelPricing, CostFields } from "./pricing.js";

export * from "./types.js";

export {
  reduceBeforeSubmitPrompt,
  reducePostToolUse,
  reducePostToolUseFailure,
  reduceAfterAgentResponse,
  reduceSubagentStart,
  reduceSubagentStop,
  reduceStop,
} from "./reducer.js";
