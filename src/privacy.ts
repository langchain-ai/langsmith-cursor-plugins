import { RunTree, type RunTreeConfig } from "langsmith";
import {
  metadataForMode as sharedMetadataForMode,
  projectCodingAgentMetadata,
} from "@langchain/plugins-base/metadata";
import { CODING_AGENT_METADATA_OPTIONS, CURSOR_INTEGRATION } from "./constants.js";
import type { TracingMode } from "./types.js";
import type { RunTreeCapture } from "./models/tracing-engine.js";

export const MUTED_TRACE_CONTENT =
  "[LangSmith system notice: content omitted because tracing is muted.]";

// Also used at the wire boundary, on CURRENT (possibly anonymized) metadata.
// It must not retrieve provenance there and restore pre-anonymization values.
function projectMetadata(
  metadata: Record<string, unknown> | undefined,
  status?: string,
): Record<string, unknown> {
  return projectCodingAgentMetadata(metadata, CURSOR_INTEGRATION, status);
}

export function metadataForMode(
  metadata: Record<string, unknown> | undefined,
  mode: TracingMode = "full",
  status?: string,
): Record<string, unknown> | undefined {
  if (mode === "full") return metadata;
  // Builder provenance wins over ALL merged fields. Plain direct RunTree
  // configs remain supported as explicitly supplied metadata, schema-filtered
  // below; plugin callsites must use the builder, not clone its merged result.
  const projected = sharedMetadataForMode(metadata, CURSOR_INTEGRATION, mode, status);
  const options = metadata ? Reflect.get(metadata, CODING_AGENT_METADATA_OPTIONS) : undefined;
  if (projected && options !== undefined) {
    Object.defineProperty(projected, CODING_AGENT_METADATA_OPTIONS, {
      value: options,
      enumerable: true,
    });
  }
  return projected;
}

function sanitizeReplica(replica: unknown, mode: TracingMode): unknown {
  if (mode === "full" || !replica || typeof replica !== "object") return replica;
  // The SDK also accepts [projectName, updates] tuples.
  if (Array.isArray(replica)) return { projectName: replica[0] };
  const { updates: _updates, ...safe } = replica as Record<string, unknown>;
  return safe;
}

export function runConfigForMode<T extends Record<string, unknown>>(
  config: T,
  mode: TracingMode = "full",
): T {
  if (mode === "full") return config;
  const status = config.error != null ? "error" : config.end_time != null ? "completed" : "running";
  const extra = config.extra as { metadata?: Record<string, unknown> } | undefined;
  const safe: Record<string, unknown> = {};
  for (const key of [
    "client",
    "id",
    "name",
    "run_type",
    "project_name",
    "start_time",
    "end_time",
    "parent_run_id",
    "parent_run",
    "distributedParentId",
    "trace_id",
    "dotted_order",
  ]) {
    if (key in config && config[key] !== undefined) safe[key] = config[key];
  }
  if (Array.isArray(config.replicas)) {
    safe.replicas = config.replicas.map((replica) => sanitizeReplica(replica, mode));
  }
  safe.inputs = { messages: [{ role: "user", content: MUTED_TRACE_CONTENT }] };
  safe.outputs = { messages: [{ role: "assistant", content: MUTED_TRACE_CONTENT }] };
  safe.extra = {
    metadata: metadataForMode(extra?.metadata, mode, status),
    // RunTree and Client both enrich extra AFTER construction. A client-level
    // omitTracedRuntimeInfo flag alone does not suppress RunTree's additions,
    // and replicas may use their own clients. Keep this method enumerable so it
    // survives SDK object spreads and filters at the REST serialization boundary
    // (including multipart .extra parts). Wire-payload tests guard this SDK behavior.
    toJSON(this: { metadata?: Record<string, unknown> }) {
      return {
        // Read the current metadata, not the constructor's copy: the client may
        // have anonymized allowlisted values, which must not be restored here.
        metadata: projectMetadata(
          this.metadata,
          typeof this.metadata?.status === "string" ? this.metadata.status : status,
        ),
      };
    },
  };
  return safe as T;
}

/**
 * Payload boundary only: callers retain control of posting, patching, timing and
 * parentage. Post/patch methods reapply the filter after lifecycle mutations. No shared client or mode state is
 * changed, so full and metadata runs can safely share a client.
 */
export function createRunTree(
  config: RunTreeConfig,
  mode: TracingMode = "full",
  capture?: RunTreeCapture,
): RunTree {
  const safe = runConfigForMode(config as RunTreeConfig & Record<string, unknown>, mode);
  return protectRun(new RunTree(safe), mode, safe.extra?.metadata, capture);
}

/** Restrict a child without changing SDK parentage or upgrading a muted parent. */
export function createChildRun(
  parent: RunTree,
  config: Parameters<RunTree["createChild"]>[0],
  mode: TracingMode,
  capture?: RunTreeCapture,
): RunTree {
  const safe = runConfigForMode(config as typeof config & Record<string, unknown>, mode);
  return protectRun(parent.createChild(safe), mode, safe.extra?.metadata, capture);
}

/** Keep SDK createChild parenting/order, but filter AFTER inherited metadata is merged.
 * Reapply before every post/patch: Cursor finalizes its root by mutation, not reconstruction.
 * Per-instance closures avoid a global mode or monkey-patching the SDK prototype.
 */
function protectRun(
  run: RunTree,
  mode: TracingMode,
  metadata?: Record<string, unknown>,
  capture?: RunTreeCapture,
): RunTree {
  if (mode === "full" && !capture) return run;
  const trusted = metadata;
  let failed = trusted?.status === "error";
  const sanitize = () => {
    if (mode === "full") return;
    failed ||= run.error != null;
    const safe = runConfigForMode(
      {
        inputs: run.inputs,
        outputs: run.outputs,
        error: failed ? "error" : undefined,
        end_time: run.end_time,
        extra: { metadata: trusted },
        replicas: run.replicas,
      },
      mode,
    );
    run.inputs = safe.inputs;
    run.outputs = safe.outputs;
    run.error = undefined;
    run.extra = safe.extra;
    run.replicas = safe.replicas;
    run.tags = [];
    run.events = undefined;
    run.attachments = undefined;
    run.serialized = {};
    run.reference_example_id = undefined;
  };
  const createChild = run.createChild.bind(run);
  run.createChild = (config) => {
    const safe = runConfigForMode(config as typeof config & Record<string, unknown>, mode);
    return protectRun(createChild(safe), mode, safe.extra?.metadata, capture);
  };
  const post = run.postRun.bind(run);
  run.postRun = async (...args) => {
    sanitize();
    if (capture) return capture(run, "post");
    return post(...args);
  };
  const patch = run.patchRun.bind(run);
  run.patchRun = async (...args) => {
    sanitize();
    if (capture) return capture(run, "patch", args[0]);
    return patch(...args);
  };
  sanitize();
  return run;
}
