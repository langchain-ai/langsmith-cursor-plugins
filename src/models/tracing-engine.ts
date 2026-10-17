import type { CodingAgentMetadataOptions } from "@langchain/plugins-base/metadata";
import type { PluginSession, PluginSessionOptions } from "@langchain/plugins-base/plugin";
import type { PreparedRunPatchSubmission } from "@langchain/plugins-base/tracing/upload";
import type { RunTree } from "langsmith";
import type { TracingMode } from "./types.js";

export interface CapturedRun {
  run: RunTree;
  mode: TracingMode;
  /** The options the run's own metadata was built from. */
  metadata: CodingAgentMetadataOptions;
}

export type RecoveryReport = Parameters<NonNullable<PluginSessionOptions["onRecoveryReport"]>>[0];

export type RunPatchContext = PreparedRunPatchSubmission["run"];

export type RunPatchValues = PreparedRunPatchSubmission["patch"]["values"];

export type CaptureStatus = Awaited<ReturnType<PluginSession["session"]["capture"]>>["status"];

export type SavedCapture = Awaited<ReturnType<PluginSession["store"]["read"]>>;
