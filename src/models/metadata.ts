import type {
  CodingAgentAgentType,
  CodingAgentMetadataOptions as SharedCodingAgentMetadataOptions,
} from "@langchain/plugins-base/metadata";

export type LSAgentType = CodingAgentAgentType;

export type CodingAgentMetadataOptions = Omit<
  SharedCodingAgentMetadataOptions,
  "integration" | "integrationVersion"
>;

export type CodingAgentLLMMetadata = Pick<
  CodingAgentMetadataOptions,
  "modelName" | "providerMetadata"
>;

/** Per-turn context shared by every run's coding-agent-v1 metadata. */
export interface MetaCtx {
  agentType: LSAgentType;
  threadId: string;
  base?: Record<string, unknown>;
  turnId?: string;
  turnNumber?: number;
  runtimeVersion?: string;
}
