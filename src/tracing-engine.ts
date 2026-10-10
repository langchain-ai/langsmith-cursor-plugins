import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, extname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createCaptureStore } from "@langchain/plugins-base/storage/capture";
import { createTracingEngine } from "@langchain/plugins-base/tracing";
import { createLangSmithUploadWriter } from "@langchain/plugins-base/tracing/upload";
import type { StoredCapture } from "@langchain/plugins-base/storage/capture";
import type {
  NormalizedRunSnapshot,
  PreparedRunSubmission,
} from "@langchain/plugins-base/tracing/upload";
import type { RunTree } from "langsmith";
import { loadConfig, type Config } from "./config.js";
import {
  CODING_AGENT_METADATA_OPTIONS,
  CURSOR_ENGINE_WORKER_ARGUMENT_LIMITS,
  CURSOR_ENGINE_PATCH_FIELDS,
  CURSOR_ENGINE_NODE_SCRIPT,
  CURSOR_ENGINE_WORKER_FLAG,
  CURSOR_ENGINE_WORKER_ENTRY,
  CURSOR_INTEGRATION,
  CURSOR_RUN_PATCH_EVENT_KIND,
  CURSOR_RUN_POST_EVENT_KIND,
} from "./constants.js";
import { isValidBoundedText } from "./utils/validation/text.js";
import type {
  CursorTracingSessionContext,
  CursorRunContext,
  CursorRunMetadataOptions,
  CursorRunPatchValues,
  CursorUploadReplica,
  CursorEngineWorkerArguments,
  RunTreeCaptureOptions,
} from "./models/tracing-engine.js";

export function createCursorTracingSession(
  config: Config,
  sessionId: string,
  cwd: string | undefined,
  launchWorker?: () => number | Promise<number>,
  destinationProject = config.project,
): CursorTracingSessionContext | undefined {
  if (!config.apiKey && !config.replicas?.length) return undefined;
  validateProjectName(destinationProject);
  const writer = writerOptions(config, destinationProject);
  const storageRoot = dirname(config.stateFilePath);
  const engine = createTracingEngine({
    storageRoot,
    integration: CURSOR_INTEGRATION,
    writer,
  });
  const session = engine.forSession({
    sessionId,
    reconstruct: async () => ({
      status: "deferred",
      reason: "missing-thread-identity",
    }),
    scheduleWake: launchWorker ?? (() => launchEngineWorker(sessionId, cwd, destinationProject)),
    resolveScope: (expected) => {
      const currentConfig = loadConfig({ cwd });
      const currentWriter = writerOptions(currentConfig, destinationProject);
      return {
        ...expected,
        accountFingerprint: currentWriter
          ? createLangSmithUploadWriter(currentWriter).accountFingerprint
          : "",
      };
    },
  });
  return {
    session,
    storageRoot,
    destinationFingerprint: createLangSmithUploadWriter(writer).accountFingerprint,
  };
}

export function createRunTreeCapture(options: RunTreeCaptureOptions) {
  const postEventByRunId = new Map<string, string>();
  const eventsByRunId = new Map<string, Set<string>>();
  const snapshots = new WeakMap<RunTree, NormalizedRunSnapshot>();
  const captureStore = createCaptureStore(options.storageRoot);
  let persistedCaptures: Promise<StoredCapture[]> | undefined;

  const storedEvents = async () => {
    if (!persistedCaptures) {
      persistedCaptures = captureStore
        .enumerate(CURSOR_INTEGRATION, options.sessionId)
        .then((captures) =>
          captures
            .map(({ record }) => record)
            .filter(
              (record) =>
                record.turnId === options.turnId &&
                record.destinationFingerprint === options.destinationFingerprint &&
                (record.eventKind === CURSOR_RUN_POST_EVENT_KIND ||
                  record.eventKind === CURSOR_RUN_PATCH_EVENT_KIND),
            )
            .sort((left, right) => left.capturedAtMs - right.capturedAtMs),
        );
    }
    return persistedCaptures;
  };

  const rememberEvent = (runId: string, eventId: string) => {
    const events = eventsByRunId.get(runId) ?? new Set<string>();
    events.add(eventId);
    eventsByRunId.set(runId, events);
  };

  return async (
    run: RunTree,
    operation: "post" | "patch",
    patchOptions?: Parameters<RunTree["patchRun"]>[0],
  ): Promise<void> => {
    const metadata = run.extra?.metadata as CursorRunMetadataOptions | undefined;
    const metadataOptions = metadata?.[CODING_AGENT_METADATA_OPTIONS];
    if (!metadataOptions) throw new Error("Run metadata options are unavailable");

    const payload = run.toJSON() as unknown as Record<string, unknown>;
    const snapshot = normalizedSnapshot(payload);
    const root = rootRun(run);
    const priorEvents = await storedEvents();
    for (const event of priorEvents) rememberEvent(event.runId, event.eventId);
    const storedPosts = priorEvents.filter(
      (event) => event.runId === run.id && event.eventKind === CURSOR_RUN_POST_EVENT_KIND,
    );
    const storedPost = storedPosts.at(-1);
    const isReplayPost = operation === "post" && storedPost !== undefined;
    let before = snapshots.get(run);
    if (isReplayPost) {
      before = snapshotAfterStoredPatches(storedPost, priorEvents);
      assertStableRunIdentity(before, snapshot);
      postEventByRunId.set(run.id, storedPost.eventId);
      snapshots.set(run, before);
    }
    const captureOperation = isReplayPost ? "patch" : operation;
    const rootPatch = captureOperation === "patch" && run.id === root.id;
    const provisionalRootPatch = rootPatch && options.closureState === "provisional";
    if (provisionalRootPatch && snapshot.error === "incomplete") delete snapshot.error;

    const privacyContext = {
      status: provisionalRootPatch ? "running" : statusOfRun(run),
    } as const;
    let submission: PreparedRunSubmission;
    if (captureOperation === "post") {
      snapshots.set(run, snapshot);
      submission = {
        operation: captureOperation,
        integration: CURSOR_INTEGRATION,
        privacyMode: options.privacyMode,
        metadata: metadataOptions,
        privacyContext,
        run: snapshot,
      };
    } else {
      const fields = CURSOR_ENGINE_PATCH_FIELDS.filter(
        (field) =>
          !(patchOptions?.excludeInputs && field === "inputs") &&
          snapshot[field] !== undefined &&
          !isDeepStrictEqual(before?.[field], snapshot[field]),
      );
      const values = Object.fromEntries(
        fields.map((field) => [field, snapshot[field]]),
      ) as CursorRunPatchValues;
      submission = {
        operation: captureOperation,
        integration: CURSOR_INTEGRATION,
        privacyMode: options.privacyMode,
        metadata: metadataOptions,
        privacyContext,
        run: isReplayPost && before ? snapshotContext(before) : normalizedContext(payload),
        patch: { fields, values },
      };
    }

    const childRunIds = descendantRunIds(root);
    const dependencies = new Set<string>();
    if (captureOperation === "post" && run.parent_run) {
      const parentEvent = postEventByRunId.get(run.parent_run.id);
      if (parentEvent) dependencies.add(parentEvent);
    } else if (captureOperation === "patch") {
      const ownPost = postEventByRunId.get(run.id);
      if (ownPost) dependencies.add(ownPost);
      if (rootPatch) {
        for (const runId of [root.id, ...childRunIds]) {
          for (const eventId of eventsByRunId.get(runId) ?? []) {
            dependencies.add(eventId);
          }
        }
      }
    }
    const dependencyIds = [...dependencies].sort();
    const turnEvidence = {
      rootRunId: root.id,
      childRunIds,
      closureState: rootPatch && !isReplayPost ? options.closureState : "open",
    } as const;
    const eventIdentity = {
      integration: CURSOR_INTEGRATION,
      sessionId: options.sessionId,
      turnId: options.turnId,
      destinationFingerprint: options.destinationFingerprint,
      operation: captureOperation,
      runId: submission.run.id,
    };
    const eventId = stableEventId(
      captureOperation === "post"
        ? eventIdentity
        : {
            ...eventIdentity,
            submission,
            turnEvidence,
            dependencies: dependencyIds,
          },
    );

    if (isReplayPost && submission.operation === "patch" && submission.patch.fields.length === 0) {
      snapshots.set(run, snapshot);
      return;
    }

    const result = await options.session.capture({
      turnId: options.turnId,
      eventId,
      submission,
      turnEvidence,
      ...(dependencyIds.length === 0
        ? {}
        : {
            dependencies: dependencyIds.map((dependencyEventId) => ({
              integration: CURSOR_INTEGRATION,
              sessionId: options.sessionId,
              turnId: options.turnId,
              eventId: dependencyEventId,
            })),
          }),
    });
    if (result.status !== "published" && result.status !== "duplicate") {
      throw new Error("Shared trace capture failed");
    }
    if (captureOperation === "post") postEventByRunId.set(run.id, eventId);
    else snapshots.set(run, snapshot);
    rememberEvent(run.id, eventId);
  };
}

export async function runCursorEngineWorker(
  sessionId: string,
  cwd: string,
  destinationProject?: string,
): Promise<void> {
  const { loadConfig } = await import("./config.js");
  const config = loadConfig({ cwd });
  const tracing = createCursorTracingSession(config, sessionId, cwd, undefined, destinationProject);
  if (!tracing) throw new Error("Shared trace worker configuration is unavailable");
  const result = await tracing.session.drain();
  if (result === "retry-exhausted" || result === "scope-mismatch") {
    throw new Error(`Shared trace worker stopped with ${result}`);
  }
}

function launchEngineWorker(
  sessionId: string,
  cwd: string | undefined,
  destinationProject: string,
): number {
  const entry = process.argv[1];
  if (!entry) throw new Error("Hook entrypoint is unavailable for shared trace worker");
  const nodeScript = CURSOR_ENGINE_NODE_SCRIPT.test(entry);
  const args = [
    ...(nodeScript ? [join(dirname(entry), `${CURSOR_ENGINE_WORKER_ENTRY}${extname(entry)}`)] : []),
    CURSOR_ENGINE_WORKER_FLAG,
    sessionId,
    cwd ?? process.cwd(),
    destinationProject,
  ];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  if (!child.pid) throw new Error("Shared trace worker failed to start");
  return child.pid;
}

export function parseCursorEngineWorkerArguments(args: string[]): CursorEngineWorkerArguments {
  const [sessionId, cwd, project, ...extra] = args;
  if (!sessionId || !cwd || extra.length > 0) {
    throw new Error("Shared trace worker arguments are missing or invalid");
  }
  validateWorkerArgument(sessionId, CURSOR_ENGINE_WORKER_ARGUMENT_LIMITS.sessionId);
  validateWorkerArgument(cwd, CURSOR_ENGINE_WORKER_ARGUMENT_LIMITS.cwd);
  if (project !== undefined) validateProjectName(project);
  return { sessionId, cwd, ...(project === undefined ? {} : { project }) };
}

function validateProjectName(project: string): void {
  if (!isValidBoundedText(project, CURSOR_ENGINE_WORKER_ARGUMENT_LIMITS.project)) {
    throw new Error("Shared trace worker project is invalid");
  }
}

function validateWorkerArgument(value: string, maxLength: number): void {
  if (!isValidBoundedText(value, maxLength)) {
    throw new Error("Shared trace worker argument is invalid");
  }
}

function normalizedSnapshot(payload: Record<string, unknown>): NormalizedRunSnapshot {
  if (
    typeof payload.id !== "string" ||
    typeof payload.name !== "string" ||
    typeof payload.run_type !== "string"
  ) {
    throw new Error("Run identity is unavailable");
  }
  return {
    id: payload.id,
    name: payload.name,
    run_type: payload.run_type,
    inputs: (payload.inputs ?? {}) as Record<string, unknown>,
    ...(isTimestamp(payload.start_time) ? { start_time: payload.start_time } : {}),
    ...(isTimestamp(payload.end_time) ? { end_time: payload.end_time } : {}),
    ...(typeof payload.outputs === "object" && payload.outputs !== null
      ? { outputs: payload.outputs as Record<string, unknown> }
      : {}),
    ...(typeof payload.parent_run_id === "string" ? { parent_run_id: payload.parent_run_id } : {}),
    ...(typeof payload.trace_id === "string" ? { trace_id: payload.trace_id } : {}),
    ...(typeof payload.dotted_order === "string" ? { dotted_order: payload.dotted_order } : {}),
    ...(Array.isArray(payload.tags) ? { tags: payload.tags as string[] } : {}),
    ...(typeof payload.error === "string" ? { error: payload.error } : {}),
    ...(typeof payload.serialized === "object" && payload.serialized !== null
      ? { serialized: payload.serialized }
      : {}),
    ...(Array.isArray(payload.events) ? { events: payload.events as RunTree["events"] } : {}),
    ...(typeof payload.reference_example_id === "string"
      ? { reference_example_id: payload.reference_example_id }
      : {}),
  };
}

function normalizedContext(payload: Record<string, unknown>): CursorRunContext {
  if (
    typeof payload.id !== "string" ||
    typeof payload.name !== "string" ||
    typeof payload.run_type !== "string"
  ) {
    throw new Error("Run identity is unavailable");
  }
  return {
    id: payload.id,
    name: payload.name,
    run_type: payload.run_type,
    ...(isTimestamp(payload.start_time) ? { start_time: payload.start_time } : {}),
    ...(typeof payload.parent_run_id === "string" ? { parent_run_id: payload.parent_run_id } : {}),
    ...(typeof payload.trace_id === "string" ? { trace_id: payload.trace_id } : {}),
    ...(typeof payload.dotted_order === "string" ? { dotted_order: payload.dotted_order } : {}),
  };
}

function isTimestamp(value: unknown): value is number | string {
  return typeof value === "number" || typeof value === "string";
}

function rootRun(run: RunTree): RunTree {
  let root = run;
  while (root.parent_run) root = root.parent_run;
  return root;
}

function descendantRunIds(root: RunTree): string[] {
  const seen = new Set<string>();
  const visit = (parent: RunTree) => {
    for (const child of parent.child_runs ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      visit(child);
    }
  };
  visit(root);
  return [...seen];
}

function statusOfRun(run: RunTree): "running" | "completed" | "error" {
  const metadataStatus = run.extra?.metadata?.status;
  if (
    metadataStatus === "running" ||
    metadataStatus === "completed" ||
    metadataStatus === "error"
  ) {
    return metadataStatus;
  }
  if (run.error != null) return "error";
  return run.end_time == null ? "running" : "completed";
}

function writerOptions(config: Config, projectName = config.project) {
  return {
    destinations: [{ apiKey: config.apiKey, apiUrl: config.apiUrl, projectName }],
    ...(config.replicas === undefined ? {} : { replicas: uploadReplicas(config.replicas) }),
    redact: config.redact,
    ...(config.redactExtraRules === undefined
      ? {}
      : {
          redactExtraRules: config.redactExtraRules.map((rule) => ({
            pattern: rule.pattern,
            ...(rule.replace === undefined ? {} : { replace: rule.replace }),
          })),
        }),
  };
}

function uploadReplicas(replicas: NonNullable<Config["replicas"]>): CursorUploadReplica[] {
  return replicas.map((replica) => {
    if (Array.isArray(replica)) {
      const [projectName, updates] = replica;
      return {
        projectName,
        ...(updates === undefined ? {} : { updates }),
      };
    }
    return {
      ...(replica.apiKey === undefined ? {} : { apiKey: replica.apiKey }),
      ...(replica.apiUrl === undefined ? {} : { apiUrl: replica.apiUrl }),
      ...(replica.projectName === undefined ? {} : { projectName: replica.projectName }),
      ...(replica.workspaceId === undefined ? {} : { workspaceId: replica.workspaceId }),
      ...(replica.updates === undefined ? {} : { updates: replica.updates }),
    };
  });
}

function snapshotAfterStoredPatches(
  post: StoredCapture,
  records: StoredCapture[],
): NormalizedRunSnapshot {
  const submission = recordObject(post.normalizedPayload);
  const snapshot = recordObject(submission?.run);
  if (submission?.operation !== "post" || snapshot?.id !== post.runId) {
    throw new Error("Persisted run post is invalid");
  }
  const current = { ...snapshot } as unknown as NormalizedRunSnapshot;
  for (const record of records) {
    if (
      record.runId !== post.runId ||
      record.eventKind !== CURSOR_RUN_PATCH_EVENT_KIND ||
      record.capturedAtMs <= post.capturedAtMs
    ) {
      continue;
    }
    const patchSubmission = recordObject(record.normalizedPayload);
    if (patchSubmission?.operation !== "patch") continue;
    const patch = recordObject(patchSubmission.patch);
    const values = recordObject(patch?.values);
    if (!Array.isArray(patch?.fields) || !values) continue;
    for (const field of patch.fields) {
      if (typeof field === "string" && Object.hasOwn(values, field)) {
        Object.assign(current, { [field]: values[field] });
      }
    }
  }
  return current;
}

function snapshotContext(snapshot: NormalizedRunSnapshot): CursorRunContext {
  return {
    id: snapshot.id,
    name: snapshot.name,
    run_type: snapshot.run_type,
    ...(snapshot.start_time === undefined ? {} : { start_time: snapshot.start_time }),
    ...(snapshot.parent_run_id === undefined ? {} : { parent_run_id: snapshot.parent_run_id }),
    ...(snapshot.trace_id === undefined ? {} : { trace_id: snapshot.trace_id }),
    ...(snapshot.dotted_order === undefined ? {} : { dotted_order: snapshot.dotted_order }),
  };
}

function assertStableRunIdentity(
  previous: NormalizedRunSnapshot,
  current: NormalizedRunSnapshot,
): void {
  const fields = [
    "id",
    "name",
    "run_type",
    "start_time",
    "parent_run_id",
    "trace_id",
    "dotted_order",
  ] as const;
  if (fields.some((field) => !isDeepStrictEqual(previous[field], current[field]))) {
    throw new Error("Persisted run identity changed");
  }
}

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stableEventId(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return serialized ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
  return `{${fields.join(",")}}`;
}
