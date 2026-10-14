import type { CodingAgentMetadataOptions } from "@langchain/plugins-base/metadata";
import type { PluginSessionOptions } from "@langchain/plugins-base/plugin";
import type { RunTree } from "langsmith";
import type { TracingMode } from "./types.js";

export interface CapturedRun {
  run: RunTree;
  mode: TracingMode;
  /** The options the run's own metadata was built from. */
  metadata: CodingAgentMetadataOptions;
}

export type RecoveryReport = Parameters<NonNullable<PluginSessionOptions["onRecoveryReport"]>>[0];

export type Reconstruct = PluginSessionOptions["reconstruct"];
