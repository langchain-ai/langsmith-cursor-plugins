import type { RunTree } from "langsmith";
import type { createRunIdentity } from "@langchain/plugins-base/tracing/lifecycle";

export interface SnapshotTestRun {
  run: RunTree;
  payload: Record<string, unknown>;
  identity: ReturnType<typeof createRunIdentity>;
}

export interface SnapshotPatchSubmission {
  fields: string[];
  values: Record<string, unknown>;
}

export interface SnapshotDependencyRecord {
  eventId: string;
  dependencies?: readonly { eventId: string }[];
}
