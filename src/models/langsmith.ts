import type { CodingAgentAgentType } from "@langchain/plugins-base/metadata";
import type { CursorMetadataOptions, LlmMetadata } from "./metadata.js";
import type { CapturedRun } from "./tracing-engine.js";
import type { ContentPart, TracingMode, TurnBuffer } from "./types.js";
import type { Step } from "./conversation-steps.js";
import type { UsageMetadata } from "./normalize.js";

export interface BuildTurnOptions {
  buffer: TurnBuffer;
  conversationId: string;
  turnNum: number;
  project: string;
  /** user_email from the hook payload, attached to runs. */
  userEmail?: string | null;
  /** coding-agent-v1 base metadata from config (repo/git/cwd/user/version). */
  customMetadata?: Record<string, unknown>;
  /** Cursor runtime version (hook `cursor_version`) → ls_agent_runtime_version. */
  runtimeVersion?: string;
  /** Image/file parts for the user message, recovered from Cursor's DB. */
  attachments?: ContentPart[];
  /** The turn's system prompt, recovered from Cursor's DB (prepended to llm runs). */
  systemPrompt?: string;
  /** True interleaved step sequence from Cursor's DB; enables per-round llm/tool fidelity. */
  steps?: Step[];
}

/** Per-turn context shared by every run's coding-agent-v1 metadata. */
export interface MetaCtx {
  agentType: CodingAgentAgentType;
  threadId: string;
  base?: Record<string, unknown>;
  turnId?: string;
  turnNumber?: number;
  runtimeVersion?: string;
}

export interface TurnCall {
  startMs: number;
  /** LangChain `tool_call` content block for the assistant message. */
  toolCallBlock: Record<string, unknown>;
  /** Tool-result message fed back into the final llm run's input. */
  resultMessage: Record<string, unknown>;
}

/** Everything the run builders share for one turn, so none of it lives in module state. */
export interface TurnContext {
  options: BuildTurnOptions;
  ctx: MetaCtx;
  runs: CapturedRun[];
  mode: TracingMode;
  userContent: ContentPart[];
  llmName: string;
  llmMeta: LlmMetadata;
  usageMetadata: UsageMetadata | undefined;
  thinking: Array<Record<string, unknown>>;
  finalTextBlocks: Array<Record<string, unknown>>;
  calls: TurnCall[];
  turnEndMs: number;
}

/** One run to create under a parent, and the metadata its capture is built from. */
export interface RunSpec {
  key: string;
  name: string;
  type: "chain" | "llm" | "tool";
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: string;
  startMs: number;
  endMs: number;
  metadata: CursorMetadataOptions;
  mode?: TracingMode;
}

/** The llm run of a root turn or of a subagent, which differ only in id, text and metadata. */
export interface LlmRunSpec {
  key: string;
  name: string;
  messages: Array<Record<string, unknown>>;
  content: Array<Record<string, unknown>>;
  startMs: number;
  endMs: number;
  metadata: CursorMetadataOptions;
}

export interface SkillRunOptions {
  skillName: string;
  /** Outcome of the read that loaded the skill, which is all Cursor reports. */
  success: boolean;
  startMs: number;
  endMs: number;
}
