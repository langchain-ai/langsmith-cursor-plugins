import type { RunTree } from "langsmith";
import type { Step } from "../conversation-steps.js";
import type { buildUsageMetadata } from "../normalize.js";
import type { ContentPart, TurnBuffer } from "../types.js";
import type { CodingAgentLLMMetadata, MetaCtx } from "./metadata.js";
import type { RunTreeCapture } from "./tracing-engine.js";

/** Inputs for the interleaved per-step renderer. */
export interface InterleaveOptions {
  turnRun: RunTree;
  ctx: MetaCtx;
  steps: Step[];
  buffer: TurnBuffer;
  userContent: ContentPart[];
  systemPrompt?: string;
  llmName: string;
  llmMeta: CodingAgentLLMMetadata;
  usageMetadata: ReturnType<typeof buildUsageMetadata>;
  finalTextBlocks: Array<Record<string, unknown>>;
  turnEndMs: number;
  capture?: RunTreeCapture;
}
