import type { RunTree } from "langsmith";
import { CURSOR_ENGINE_WORKER_MODE_SWEEP } from "../constants.js";
import type { TracingEngineSession } from "@langchain/plugins-base/tracing";
import type { CodingAgentMetadataOptions } from "@langchain/plugins-base/metadata";
import type {
  LifecycleCaptureResult,
  LifecycleSnapshotCaptureInput,
} from "@langchain/plugins-base/tracing/lifecycle";
import type { ReconstructionOutput } from "@langchain/plugins-base/tracing/reconstruction";
import type { ReconstructionJob } from "@langchain/plugins-base/tracing/reconstruction";
import type { CODING_AGENT_METADATA_OPTIONS } from "../constants.js";
import type {
  NormalizedRunSnapshot,
  PreparedRunSubmission,
} from "@langchain/plugins-base/tracing/upload";
import type { Config } from "../config.js";

export type { TracingEngineSession } from "@langchain/plugins-base/tracing";

export type RunTreeCapture = (
  run: RunTree,
  operation: "post" | "patch",
  patchOptions?: Parameters<RunTree["patchRun"]>[0],
) => Promise<void>;

export type RunTreeSnapshotCapture = (
  input: LifecycleSnapshotCaptureInput,
  operation: "post" | "patch",
) => Promise<LifecycleCaptureResult>;

export interface RunTreeCaptureOptions {
  session: TracingEngineSession;
  sessionId: string;
  turnId: string;
  privacyMode: "full" | "metadata";
  closureState: "provisional" | "authoritative";
  storageRoot: string;
  destinationFingerprint: string;
  sourceAgeStartedAtMs?: number;
}

export interface CursorTracingSessionContext {
  session: TracingEngineSession;
  storageRoot: string;
  destinationFingerprint: string;
}

export interface CursorReconstructionCaptureOptions extends Omit<
  RunTreeCaptureOptions,
  "closureState"
> {
  jobEventId: string;
  sourceRef: string;
  sourceAgeStartedAtMs: number;
}

export interface CursorReconstructionCapture {
  capture: RunTreeCapture;
  outputs: ReconstructionOutput[];
}

export interface CursorNativeReconstructionOptions {
  config: Config;
  cwd: string;
  destinationFingerprint: string;
  job: ReconstructionJob;
  session: TracingEngineSession;
  sessionId: string;
  storageRoot: string;
}

export interface CursorReconstructionPatch {
  submission: CursorReconstructionPatchSubmission;
  fields: CursorReconstructionPatchField[];
  values: CursorReconstructionPatchValues;
}

export type CursorReconstructionPatchField = "inputs" | "outputs" | "end_time" | "error";

export interface CursorReconstructionPatchValues {
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  end_time?: number | string;
  error?: string;
}

export type CursorReconstructionPatchSubmission = Extract<
  PreparedRunSubmission,
  { operation: "patch" }
> & {
  patch: {
    fields: CursorReconstructionPatchField[];
    values: CursorReconstructionPatchValues;
  };
};

export interface CursorEngineWorkerArguments {
  sessionId: string;
  cwd: string;
  project?: string;
  mode?: typeof CURSOR_ENGINE_WORKER_MODE_SWEEP;
  callerConversationId?: string;
  pruneState?: boolean;
}

export interface TracingEngineTurnContext {
  session: TracingEngineSession;
  sessionId: string;
  closureState: "provisional" | "authoritative";
  storageRoot: string;
  destinationFingerprint: string;
  capture?: RunTreeCapture;
}

export interface CursorReconstructionRunState {
  existingSnapshot?: NormalizedRunSnapshot;
  existingHeadEventIds: string[];
}

export interface CursorUploadReplica {
  apiKey?: string;
  apiUrl?: string;
  projectName?: string;
  workspaceId?: string;
  updates?: Record<string, unknown>;
}

export interface CursorRunMetadataOptions extends Record<string, unknown> {
  [CODING_AGENT_METADATA_OPTIONS]?: CodingAgentMetadataOptions;
}
