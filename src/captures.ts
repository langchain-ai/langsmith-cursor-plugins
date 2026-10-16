import { buildCodingAgentMetadata } from "@langchain/plugins-base/metadata";
import type { CodingAgentMetadataOptions } from "@langchain/plugins-base/metadata";
import type { LifecycleCaptureInput } from "@langchain/plugins-base/tracing/lifecycle";
import type { NormalizedRunSnapshot } from "@langchain/plugins-base/tracing/upload";
import type { RunTree } from "langsmith";
import {
  LS_INTEGRATION,
  PATCH_EVENT_PREFIX,
  RUN_EVENT_PREFIX,
  RUN_PATCH_FIELDS,
  RUN_SNAPSHOT_FIELDS,
} from "./constants.js";
import type { CapturedRun, RunPatchContext, RunPatchValues } from "./models/tracing-engine.js";
import { withoutUndefined } from "./utils/json.js";

export function turnCaptures(runs: readonly CapturedRun[]): LifecycleCaptureInput[] {
  const rootRunId = runs[0]?.run.id;
  if (!rootRunId) return [];
  const childRunIds = runs.slice(1).map(({ run }) => run.id);
  return runs.map((captured) => {
    const { run, mode } = captured;
    return {
      turnId: rootRunId,
      eventId: `${RUN_EVENT_PREFIX}${run.id}`,
      submission: {
        operation: "post",
        integration: LS_INTEGRATION,
        privacyMode: mode,
        metadata: metadataWithInherited(captured),
        privacyContext: { status: runStatus(run) },
        run: runSnapshot(run, mode),
      },
      turnEvidence:
        run.id !== rootRunId
          ? { childRunIds: [run.id], closureState: "open" }
          : run.end_time != null
            ? { rootRunId, childRunIds, closureState: "authoritative" }
            : { rootRunId, childRunIds: [], closureState: "open" },
    };
  });
}

export function rootPatch(post: LifecycleCaptureInput, sessionId: string): LifecycleCaptureInput {
  const { submission } = post;
  if (submission.operation !== "post") return post;
  const { id, name, run_type, start_time, parent_run_id, trace_id, dotted_order } = submission.run;
  const context: RunPatchContext = withoutUndefined({
    id,
    name,
    run_type,
    start_time,
    parent_run_id,
    trace_id,
    dotted_order,
  });
  const { outputs, end_time, error } = submission.run;
  const values: RunPatchValues = withoutUndefined({ outputs, end_time, error });
  return {
    turnId: post.turnId,
    eventId: post.eventId.replace(RUN_EVENT_PREFIX, PATCH_EVENT_PREFIX),
    submission: {
      operation: "patch",
      integration: submission.integration,
      privacyMode: submission.privacyMode,
      metadata: submission.metadata,
      privacyContext: submission.privacyContext!,
      run: context,
      patch: { fields: RUN_PATCH_FIELDS.filter((field) => values[field] !== undefined), values },
    },
    turnEvidence: { rootRunId: id, childRunIds: [], closureState: "authoritative" },
    dependencies: [
      { integration: LS_INTEGRATION, sessionId, turnId: post.turnId, eventId: post.eventId },
    ],
  };
}

function runStatus(run: RunTree): "error" | "completed" | "running" {
  if (run.error != null) return "error";
  if (run.end_time != null) return "completed";
  return "running";
}

function runSnapshot(run: RunTree, mode: CapturedRun["mode"]): NormalizedRunSnapshot {
  return withoutUndefined(
    Object.fromEntries([
      ...RUN_SNAPSHOT_FIELDS.map((key) => [key, run[key]]),
      ["parent_run_id", run.parent_run?.id],
      ...(mode === "metadata" ? [["tags", []]] : []),
    ]),
  ) as NormalizedRunSnapshot;
}

function metadataWithInherited({ run, metadata }: CapturedRun): CodingAgentMetadataOptions {
  const own = buildCodingAgentMetadata(metadata);
  const inherited = Object.fromEntries(
    Object.entries(run.extra?.metadata ?? {}).filter(([key]) => !(key in own)),
  );
  return withoutUndefined({ ...metadata, runSpecific: { ...inherited, ...metadata.runSpecific } });
}
