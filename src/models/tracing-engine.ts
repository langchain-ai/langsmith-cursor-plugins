import type { RunTree } from "langsmith";
import type { TracingEngineSession } from "@langchain/plugins-base/tracing";
import type { CodingAgentMetadataOptions } from "@langchain/plugins-base/metadata";
import type { CODING_AGENT_METADATA_OPTIONS } from "../constants.js";

export type { TracingEngineSession } from "@langchain/plugins-base/tracing";

export type RunTreeCapture = (
  run: RunTree,
  operation: "post" | "patch",
  patchOptions?: Parameters<RunTree["patchRun"]>[0],
) => Promise<void>;

export interface RunTreeCaptureOptions {
  session: TracingEngineSession;
  sessionId: string;
  turnId: string;
  privacyMode: "full" | "metadata";
  closureState: "provisional" | "authoritative";
  storageRoot: string;
  destinationFingerprint: string;
}

export interface CursorTracingSessionContext {
  session: TracingEngineSession;
  storageRoot: string;
  destinationFingerprint: string;
}

export interface CursorEngineWorkerArguments {
  sessionId: string;
  cwd: string;
  project?: string;
}

export interface TracingEngineTurnContext {
  session: TracingEngineSession;
  sessionId: string;
  closureState: "provisional" | "authoritative";
  storageRoot: string;
  destinationFingerprint: string;
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
