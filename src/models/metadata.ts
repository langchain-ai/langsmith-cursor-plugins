import type { CodingAgentMetadataOptions } from "@langchain/plugins-base/metadata";

export type CursorMetadataOptions = Omit<
  CodingAgentMetadataOptions,
  "integration" | "integrationVersion"
>;

export type LlmMetadata = Pick<CursorMetadataOptions, "runType" | "modelName" | "runSpecific">;
