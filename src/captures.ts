import { buildCodingAgentMetadata } from "@langchain/plugins-base/metadata";
import type { CodingAgentMetadataOptions } from "@langchain/plugins-base/metadata";
import type { LifecycleCaptureInput } from "@langchain/plugins-base/tracing/lifecycle";
import type { NormalizedRunSnapshot } from "@langchain/plugins-base/tracing/upload";
import type { RunTree } from "langsmith";
import { LS_INTEGRATION, RUN_EVENT_PREFIX, RUN_SNAPSHOT_FIELDS } from "./constants.js";
import type { CapturedRun } from "./models/tracing-engine.js";
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
        run.id === rootRunId
          ? { rootRunId, childRunIds, closureState: "authoritative" }
          : { childRunIds: [], closureState: "open" },
    };
  });
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
