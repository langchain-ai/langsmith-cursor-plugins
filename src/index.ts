/**
 * Public API — re-exports for programmatic use and testing.
 */

export { loadConfig, parseRepoName, getRepoName } from "./config.js";
export type { Config } from "./config.js";

export {
  initTracing,
  buildTurnRuns,
  submitFeedback,
  flushPendingTraces,
  generateDottedOrderSegment,
  parseDottedOrder,
} from "./langsmith.js";
export type { BuiltTurn, FeedbackTarget, FeedbackPayload } from "./langsmith.js";

export { parseFeedbackCommand, feedbackHelpText } from "./feedback.js";
export type { FeedbackCommand, ParsedFeedback } from "./feedback.js";

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
  reduceRecordLastTrace,
} from "./reducer.js";
