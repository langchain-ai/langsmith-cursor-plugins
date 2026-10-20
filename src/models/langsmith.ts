import type { RunTree } from "langsmith";
import type { LSAgentType } from "./metadata.js";
import type { ContentPart, TurnBuffer } from "./types.js";
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
  agentType: LSAgentType;
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

/** Inputs for the interleaved per-step renderer. */
export interface InterleaveOptions {
  turnRun: RunTree;
  ctx: MetaCtx;
  steps: Step[];
  buffer: TurnBuffer;
  userContent: ContentPart[];
  systemPrompt?: string;
  llmName: string;
  llmMeta: Record<string, unknown>;
  usageMetadata: UsageMetadata | undefined;
  finalTextBlocks: Array<Record<string, unknown>>;
  turnEndMs: number;
}

export interface SkillRunOptions {
  skillName: string;
  /** Outcome of the read that loaded the skill, which is all Cursor reports. */
  success: boolean;
  startMs: number;
  endMs: number;
}
