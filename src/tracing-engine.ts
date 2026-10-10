import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, extname, join } from "node:path";
import {
  createCaptureStore,
  type CaptureDependency,
  type StoredCapture,
} from "@langchain/plugins-base/storage/capture";
import {
  CaptureWakeError,
  createTracingEngine,
  readSavedCaptureWake,
} from "@langchain/plugins-base/tracing";
import { resolveUploadDestinationFingerprint } from "@langchain/plugins-base/tracing/upload-identity";
import type { LifecycleSnapshotCaptureInput } from "@langchain/plugins-base/tracing/lifecycle";
import type {
  ReconstructionCallback,
  ReconstructionOutput,
} from "@langchain/plugins-base/tracing/reconstruction";
import type {
  NormalizedRunSnapshot,
  PreparedRunSubmission,
} from "@langchain/plugins-base/tracing/upload";
import type { RunTree } from "langsmith";
import { loadConfig, type Config } from "./config.js";
import {
  CODING_AGENT_METADATA_OPTIONS,
  CURSOR_ENGINE_WORKER_ARGUMENT_LIMITS,
  CURSOR_ENGINE_NODE_SCRIPT,
  CURSOR_ENGINE_WORKER_FLAG,
  CURSOR_ENGINE_WORKER_ENTRY,
  CURSOR_ENGINE_WORKER_MODE_SWEEP,
  CURSOR_ENGINE_WORKER_PRUNE,
  CURSOR_ENGINE_WORKER_KEEP,
  CURSOR_ENGINE_DEFAULT_MODEL,
  CURSOR_INTEGRATION,
  CURSOR_RUN_PATCH_EVENT_KIND,
  CURSOR_RUN_POST_EVENT_KIND,
  CURSOR_STOP_RECONSTRUCTION_EVENT_KIND,
  CURSOR_RECONSTRUCTION_PATCH_FIELDS,
} from "./constants.js";
import { isRecord } from "./utils/validation/record.js";
import { toJsonValue } from "./utils/serialization/json.js";
import { isValidBoundedText } from "./utils/validation/text.js";
import { validateProjectName, writerOptions } from "./tracing-engine-config.js";
import type {
  CursorReconstructionCapture,
  CursorReconstructionCaptureOptions,
  CursorReconstructionPatch,
  CursorReconstructionPatchField,
  CursorReconstructionPatchValues,
  CursorReconstructionPatchSubmission,
  CursorTracingSessionContext,
  CursorRunMetadataOptions,
  CursorEngineWorkerArguments,
  RunTreeCaptureOptions,
  RunTreeSnapshotCapture,
  CursorNativeReconstructionOptions,
} from "./models/tracing-engine.js";
import type { HookInputBase } from "./types.js";

export function createCursorTracingSession(
  config: Config,
  sessionId: string,
  cwd: string | undefined,
  launchWorker?: () => number | Promise<number>,
  destinationProject = config.project,
  reconstruct?: ReconstructionCallback,
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
    reconstruct:
      reconstruct ??
      (async () => ({
        status: "deferred",
        reason: "missing-thread-identity",
      })),
    scheduleWake: launchWorker ?? (() => launchEngineWorker(sessionId, cwd, destinationProject)),
    resolveScope: (expected) => {
      const currentConfig = loadConfig({ cwd, includeGitMetadata: false });
      const currentWriter = writerOptions(currentConfig, destinationProject);
      return {
        ...expected,
        accountFingerprint: currentWriter ? resolveUploadDestinationFingerprint(currentWriter) : "",
      };
    },
  });
  return {
    session,
    storageRoot,
    destinationFingerprint: resolveUploadDestinationFingerprint(writer),
  };
}

export function createRunTreeCapture(
  options: RunTreeCaptureOptions,
  snapshotCapture?: RunTreeSnapshotCapture,
) {
  const inputsByRun = new WeakMap<RunTree, Record<string, unknown>>();
  const captureStore = createCaptureStore(options.storageRoot);
  let persistedCaptures: Promise<StoredCapture[]> | undefined;
  let storedRecords: StoredCapture[] | undefined;

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
            ),
        );
    }
    storedRecords ??= await persistedCaptures;
    return storedRecords;
  };

  const rememberRecord = (record: StoredCapture) => {
    const records = storedRecords ?? [];
    const index = records.findIndex((candidate) => candidate.eventId === record.eventId);
    if (index === -1) records.push(record);
    else records[index] = record;
    storedRecords = records;
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
    const records = await storedEvents();
    const rootPatch = operation === "patch" && run.id === root.id;
    const provisionalRootPatch = rootPatch && options.closureState === "provisional";
    if (provisionalRootPatch && snapshot.error === "incomplete") delete snapshot.error;
    const previousInputs = inputsByRun.get(run);
    if (operation === "patch" && patchOptions?.excludeInputs && previousInputs) {
      snapshot.inputs = structuredClone(previousInputs);
    }

    const privacyContext = {
      status: provisionalRootPatch ? "running" : statusOfRun(run),
    } as const;
    const submission = {
      operation: "post",
      integration: CURSOR_INTEGRATION,
      privacyMode: options.privacyMode,
      metadata: metadataOptions,
      privacyContext,
      run: snapshot,
    } satisfies Extract<PreparedRunSubmission, { operation: "post" }>;

    const childRunIds = descendantRunIds(root);
    const dependencyIds = new Set<string>();
    if (operation === "post" && run.parent_run) {
      for (const eventId of snapshotHeadEventIds(records, run.parent_run.id)) {
        dependencyIds.add(eventId);
      }
    }
    if (rootPatch) {
      for (const runId of childRunIds) {
        for (const eventId of snapshotHeadEventIds(records, runId)) dependencyIds.add(eventId);
      }
    }
    const dependencies = [...dependencyIds].sort().map((eventId) => ({
      integration: CURSOR_INTEGRATION,
      sessionId: options.sessionId,
      turnId: options.turnId,
      eventId,
    }));
    const turnEvidence = {
      rootRunId: root.id,
      childRunIds,
      closureState: rootPatch ? options.closureState : "open",
    } as const;
    const captureInput: LifecycleSnapshotCaptureInput = {
      turnId: options.turnId,
      eventId: stableEventId(options, snapshot.id),
      submission,
      turnEvidence,
      ...(options.sourceAgeStartedAtMs === undefined
        ? {}
        : { sourceAgeStartedAtMs: options.sourceAgeStartedAtMs }),
      ...(dependencies.length === 0 ? {} : { dependencies }),
    };
    const result = await (async () => {
      try {
        return await (snapshotCapture ?? ((input) => options.session.captureSnapshot(input)))(
          captureInput,
          operation,
        );
      } catch (error) {
        if (!(error instanceof CaptureWakeError)) throw error;
        const saved = await readSavedCaptureWake(error, {
          store: captureStore,
          integration: CURSOR_INTEGRATION,
          sessionId: options.sessionId,
          turnId: options.turnId,
          destinationFingerprint: options.destinationFingerprint,
          runId: snapshot.id,
        });
        if (!saved || !isExpectedSnapshotRecord(saved.record, options, snapshot.id)) throw error;
        return saved;
      }
    })();
    if (result.status !== "published" && result.status !== "duplicate") {
      throw new Error("Shared trace capture failed");
    }
    if (!isExpectedSnapshotRecord(result.record, options, snapshot.id)) {
      throw new Error("Shared trace capture returned an invalid run snapshot");
    }
    inputsByRun.set(run, structuredClone(snapshot.inputs));
    rememberRecord(result.record);
  };
}

export async function createCursorReconstructionCapture(
  options: CursorReconstructionCaptureOptions,
): Promise<CursorReconstructionCapture> {
  const store = createCaptureStore(options.storageRoot);
  const existingCaptures = (await store.enumerate(CURSOR_INTEGRATION, options.sessionId))
    .map(({ record }) => record)
    .filter(
      (record) =>
        record.turnId === options.turnId &&
        record.destinationFingerprint === options.destinationFingerprint &&
        (record.eventKind === CURSOR_RUN_POST_EVENT_KIND ||
          record.eventKind === CURSOR_RUN_PATCH_EVENT_KIND),
    );
  const existingByRun = new Map<string, StoredCapture[]>();
  for (const record of existingCaptures) {
    const records = existingByRun.get(record.runId) ?? [];
    records.push(record);
    existingByRun.set(record.runId, records);
  }
  const existingSnapshots = new Map(
    [...existingByRun].flatMap(([runId, records]) => {
      const snapshot = latestSnapshot(records);
      return snapshot ? [[runId, snapshot] as const] : [];
    }),
  );
  const existingHeads = new Map(
    [...existingByRun].map(([runId, records]) => [runId, snapshotHeadEventIds(records, runId)]),
  );
  const outputEventIds = new Map<string, string>();
  const outputMap = new Map<string, ReconstructionOutput>();
  const captureOptions = { ...options, closureState: "authoritative" as const };
  const capture = createRunTreeCapture(captureOptions, async (input, operation) => {
    const current = structuredClone(input.submission.run);
    const runId = current.id;
    const isRoot = input.turnEvidence.rootRunId === runId;
    const savedBeforeJob = existingSnapshots.has(runId);
    const previous = existingSnapshots.get(runId);
    const eventId =
      operation === "patch" && isRoot
        ? reconstructionOutputEventId(options.jobEventId, runId, "close")
        : reconstructionOutputEventId(
            options.jobEventId,
            runId,
            savedBeforeJob ? "update" : "post",
          );
    let submission: PreparedRunSubmission | undefined;
    if (operation === "patch" && isRoot) {
      submission = reconstructionPatch(input.submission, previous, true).submission;
    } else if (isRoot && savedBeforeJob) {
      submission = undefined;
    } else if (savedBeforeJob) {
      const patch = reconstructionPatch(input.submission, previous, false);
      submission = patch.fields.length === 0 ? undefined : patch.submission;
    } else {
      submission = input.submission;
    }

    if (submission) {
      const dependencies = reconstructionDependencies(
        input.dependencies ?? [],
        outputEventIds,
        eventId,
      );
      const ownHeads = existingHeads.get(runId) ?? [];
      for (const head of ownHeads) {
        dependencies.push(
          reconstructionDependency(
            {
              integration: CURSOR_INTEGRATION,
              sessionId: options.sessionId,
              turnId: options.turnId,
            },
            outputEventIds.get(head) ?? head,
          ),
        );
      }
      if (operation === "patch" && isRoot && ownHeads.length === 0) {
        const initial = outputEventIds.get(stableEventId(captureOptions, runId));
        if (initial) {
          dependencies.push(
            reconstructionDependency(
              {
                integration: CURSOR_INTEGRATION,
                sessionId: options.sessionId,
                turnId: options.turnId,
              },
              initial,
            ),
          );
        }
      }
      const output: ReconstructionOutput = {
        eventId,
        submission,
        turnEvidence: input.turnEvidence,
        ...(dependencies.length === 0 ? {} : { dependencies: uniqueDependencies(dependencies) }),
        sourceRef: options.sourceRef,
      };
      outputMap.set(reconstructionOutputKey(runId, operation, isRoot, savedBeforeJob), output);
      outputEventIds.set(input.eventId, eventId);
      for (const head of ownHeads) outputEventIds.set(head, eventId);
    } else if (savedBeforeJob && !isRoot) {
      outputMap.delete(reconstructionOutputKey(runId, operation, isRoot, savedBeforeJob));
      for (const head of existingHeads.get(runId) ?? []) outputEventIds.set(head, head);
    }
    const record: StoredCapture = {
      version: 1,
      capturedAtMs: Date.now(),
      integration: CURSOR_INTEGRATION,
      sessionId: options.sessionId,
      turnId: input.turnId,
      eventId: input.eventId,
      runId,
      destinationFingerprint: options.destinationFingerprint,
      eventKind: operation === "patch" ? CURSOR_RUN_PATCH_EVENT_KIND : CURSOR_RUN_POST_EVENT_KIND,
      normalizedPayload: toJsonValue(
        input.submission,
        "Cursor reconstruction capture is not serializable",
      ),
      turnEvidence: toJsonValue(
        input.turnEvidence,
        "Cursor reconstruction capture is not serializable",
      ),
      metadataProvenance: toJsonValue(
        input.submission.metadata,
        "Cursor reconstruction capture is not serializable",
      ),
      sourceAgeStartedAtMs: options.sourceAgeStartedAtMs,
      ...(input.dependencies === undefined ? {} : { dependencies: input.dependencies }),
    };
    return { status: "published", record };
  });
  return {
    capture,
    get outputs() {
      return [...outputMap.values()];
    },
  };
}

function reconstructionOutputKey(
  runId: string,
  operation: "post" | "patch",
  isRoot: boolean,
  savedBeforeJob: boolean,
): string {
  const phase = isRoot
    ? operation === "patch"
      ? "close"
      : "post"
    : savedBeforeJob
      ? "update"
      : "post";
  return JSON.stringify([runId, phase]);
}

function latestSnapshot(records: readonly StoredCapture[]): NormalizedRunSnapshot | undefined {
  let snapshot: NormalizedRunSnapshot | undefined;
  for (const record of [...records].sort((left, right) => left.capturedAtMs - right.capturedAtMs)) {
    if (!isRecord(record.normalizedPayload)) continue;
    const payload = record.normalizedPayload;
    if (payload.operation === "post" && isRunSnapshot(payload.run)) {
      snapshot = structuredClone(payload.run);
      continue;
    }
    if (
      payload.operation !== "patch" ||
      !snapshot ||
      !isRecord(payload.patch) ||
      !Array.isArray(payload.patch.fields) ||
      !isRecord(payload.patch.values)
    ) {
      continue;
    }
    for (const field of payload.patch.fields) {
      if (typeof field === "string" && Object.hasOwn(payload.patch.values, field)) {
        (snapshot as unknown as Record<string, unknown>)[field] = structuredClone(
          payload.patch.values[field],
        );
      }
    }
  }
  return snapshot;
}

function isRunSnapshot(value: unknown): value is NormalizedRunSnapshot {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.run_type === "string" &&
    isRecord(value.inputs)
  );
}

function reconstructionPatch(
  post: Extract<PreparedRunSubmission, { operation: "post" }>,
  previous: NormalizedRunSnapshot | undefined,
  force: boolean,
): CursorReconstructionPatch {
  const fields: CursorReconstructionPatchField[] = [];
  const values: CursorReconstructionPatchValues = {};
  for (const field of CURSOR_RECONSTRUCTION_PATCH_FIELDS) {
    const next = post.run[field];
    const old = previous?.[field];
    if (next !== undefined && (old === undefined || JSON.stringify(old) !== JSON.stringify(next))) {
      fields.push(field);
      (values as Record<string, unknown>)[field] = structuredClone(next);
    } else if (next === undefined && old !== undefined && field === "error") {
      fields.push(field);
      values.error = "";
    }
  }
  if (fields.length === 0 && force) {
    fields.push("end_time");
    values.end_time = post.run.end_time ?? post.run.start_time ?? 0;
  }
  const status =
    post.privacyContext?.status ??
    (post.run.error != null ? "error" : post.run.end_time == null ? "running" : "completed");
  const submission: CursorReconstructionPatchSubmission = {
    operation: "patch",
    integration: post.integration,
    privacyMode: post.privacyMode,
    ...(post.redactedFields === undefined ? {} : { redactedFields: post.redactedFields }),
    metadata: post.metadata,
    privacyContext: { status },
    run: {
      id: post.run.id,
      name: post.run.name,
      run_type: post.run.run_type,
      ...(post.run.start_time === undefined ? {} : { start_time: post.run.start_time }),
      ...(post.run.parent_run_id === undefined ? {} : { parent_run_id: post.run.parent_run_id }),
      ...(post.run.trace_id === undefined ? {} : { trace_id: post.run.trace_id }),
      ...(post.run.dotted_order === undefined ? {} : { dotted_order: post.run.dotted_order }),
    },
    patch: { fields, values },
  };
  return { submission, fields, values };
}

function reconstructionDependencies(
  dependencies: readonly CaptureDependency[],
  outputEventIds: ReadonlyMap<string, string>,
  dependentEventId: string,
): CaptureDependency[] {
  return dependencies
    .map((dependency) =>
      reconstructionDependency(
        dependency,
        outputEventIds.get(dependency.eventId) ?? dependency.eventId,
      ),
    )
    .filter((dependency) => dependency.eventId !== dependentEventId);
}

function reconstructionDependency(
  scope: Pick<CaptureDependency, "integration" | "sessionId" | "turnId">,
  eventId: string,
): CaptureDependency {
  return {
    integration: scope.integration,
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    eventId,
  };
}

function uniqueDependencies(dependencies: readonly CaptureDependency[]): CaptureDependency[] {
  const seen = new Set<string>();
  return dependencies.filter((dependency) => {
    const key = JSON.stringify(dependency);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function reconstructionOutputEventId(jobEventId: string, runId: string, phase: string): string {
  return createHash("sha256")
    .update(JSON.stringify([CURSOR_INTEGRATION, jobEventId, runId, phase, "reconstruction-output"]))
    .digest("hex");
}

export async function runCursorEngineWorker(worker: CursorEngineWorkerArguments): Promise<void> {
  const { loadConfig } = await import("./config.js");
  const { reconstructCursorTurn } = await import("./langsmith.js");
  const config = loadConfig({ cwd: worker.cwd, includeGitMetadata: false });
  if (worker.mode === CURSOR_ENGINE_WORKER_MODE_SWEEP) {
    if (!worker.callerConversationId) throw new Error("Cursor sweep worker caller is missing");
    const { runSweep } = await import("./sweep.js");
    const { pruneOldConversations } = await import("./state.js");
    const input: HookInputBase = {
      conversation_id: worker.callerConversationId,
      generation_id: worker.callerConversationId,
      session_id: worker.sessionId,
      model: CURSOR_ENGINE_DEFAULT_MODEL,
      hook_event_name: "sessionStart",
      workspace_roots: [worker.cwd],
    };
    await runSweep({
      config,
      input,
      ...(worker.pruneState ? { apply: (state) => pruneOldConversations(state) } : {}),
    });
    return;
  }
  const { initTracing } = await import("./langsmith.js");
  initTracing(
    config.apiKey,
    config.apiUrl,
    config.replicas,
    config.redact,
    config.redactExtraRules,
  );
  let tracingContext: CursorTracingSessionContext | undefined;
  const reconstruct: ReconstructionCallback = async (job) => {
    if (!tracingContext) throw new Error("Cursor trace worker is not initialized");
    return reconstructCursorTurn({
      config,
      cwd: worker.cwd,
      destinationFingerprint: tracingContext.destinationFingerprint,
      job,
      session: tracingContext.session,
      sessionId: worker.sessionId,
      storageRoot: tracingContext.storageRoot,
    } satisfies CursorNativeReconstructionOptions);
  };
  const tracing = createCursorTracingSession(
    config,
    worker.sessionId,
    worker.cwd,
    undefined,
    worker.project,
    reconstruct,
  );
  if (!tracing) throw new Error("Shared trace worker configuration is unavailable");
  tracingContext = tracing;
  const result = await tracing.session.drain();
  if (result === "retry-exhausted" || result === "scope-mismatch") {
    throw new Error(`Shared trace worker stopped with ${result}`);
  }
}

function launchEngineWorker(
  sessionId: string,
  cwd: string | undefined,
  destinationProject: string,
  task?: Pick<CursorEngineWorkerArguments, "mode" | "callerConversationId" | "pruneState">,
): number {
  const entry = process.argv[1];
  if (!entry) throw new Error("Hook entrypoint is unavailable for shared trace worker");
  const nodeScript = CURSOR_ENGINE_NODE_SCRIPT.test(entry);
  if (task?.mode === CURSOR_ENGINE_WORKER_MODE_SWEEP && !task.callerConversationId) {
    throw new Error("Cursor sweep worker caller is missing");
  }
  const args: string[] = [
    ...(nodeScript ? [join(dirname(entry), `${CURSOR_ENGINE_WORKER_ENTRY}${extname(entry)}`)] : []),
    CURSOR_ENGINE_WORKER_FLAG,
    sessionId,
    cwd ?? process.cwd(),
    destinationProject,
    ...(task?.mode === CURSOR_ENGINE_WORKER_MODE_SWEEP
      ? [
          task.mode,
          task.callerConversationId!,
          task.pruneState ? CURSOR_ENGINE_WORKER_PRUNE : CURSOR_ENGINE_WORKER_KEEP,
        ]
      : []),
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
  const [sessionId, cwd, project, mode, callerConversationId, pruneMode, ...extra] = args;
  if (
    !sessionId ||
    !cwd ||
    extra.length > 0 ||
    (mode !== undefined &&
      (mode !== CURSOR_ENGINE_WORKER_MODE_SWEEP ||
        !callerConversationId ||
        !pruneMode ||
        (pruneMode !== CURSOR_ENGINE_WORKER_PRUNE && pruneMode !== CURSOR_ENGINE_WORKER_KEEP)))
  ) {
    throw new Error("Shared trace worker arguments are missing or invalid");
  }
  validateWorkerArgument(sessionId, CURSOR_ENGINE_WORKER_ARGUMENT_LIMITS.sessionId);
  validateWorkerArgument(cwd, CURSOR_ENGINE_WORKER_ARGUMENT_LIMITS.cwd);
  if (project !== undefined) validateProjectName(project);
  if (callerConversationId !== undefined) {
    validateWorkerArgument(
      callerConversationId,
      CURSOR_ENGINE_WORKER_ARGUMENT_LIMITS.callerConversationId,
    );
  }
  return {
    sessionId,
    cwd,
    ...(project === undefined ? {} : { project }),
    ...(mode === CURSOR_ENGINE_WORKER_MODE_SWEEP
      ? { mode, callerConversationId, pruneState: pruneMode === CURSOR_ENGINE_WORKER_PRUNE }
      : {}),
  };
}

export function launchCursorSweepWorker(
  config: Config,
  input: HookInputBase,
  pruneState = false,
): number {
  const sessionId = input.session_id ?? input.conversation_id;
  const cwd =
    input.workspace_roots?.[0] ??
    (typeof config.customMetadata?.cwd === "string" ? config.customMetadata.cwd : process.cwd());
  return launchEngineWorker(sessionId, cwd, config.project, {
    mode: CURSOR_ENGINE_WORKER_MODE_SWEEP,
    callerConversationId: input.conversation_id,
    pruneState,
  });
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

function snapshotHeadEventIds(records: readonly StoredCapture[], runId: string): string[] {
  const runRecords = records.filter((record) => record.runId === runId);
  const eventIds = new Set(runRecords.map((record) => record.eventId));
  const referenced = new Set<string>();
  for (const record of runRecords) {
    for (const dependency of record.dependencies ?? []) {
      if (
        dependency.integration === CURSOR_INTEGRATION &&
        dependency.sessionId === record.sessionId &&
        dependency.turnId === record.turnId &&
        eventIds.has(dependency.eventId)
      ) {
        referenced.add(dependency.eventId);
      }
    }
  }
  return runRecords
    .filter((record) => !referenced.has(record.eventId))
    .map((record) => record.eventId)
    .sort();
}

function isExpectedSnapshotRecord(
  record: StoredCapture,
  options: RunTreeCaptureOptions,
  runId: string,
): boolean {
  return (
    record.integration === CURSOR_INTEGRATION &&
    record.sessionId === options.sessionId &&
    record.turnId === options.turnId &&
    record.destinationFingerprint === options.destinationFingerprint &&
    record.runId === runId &&
    (record.eventKind === CURSOR_RUN_POST_EVENT_KIND ||
      record.eventKind === CURSOR_RUN_PATCH_EVENT_KIND)
  );
}

function stableEventId(options: RunTreeCaptureOptions, runId: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        CURSOR_INTEGRATION,
        options.sessionId,
        options.turnId,
        options.destinationFingerprint,
        runId,
      ]),
    )
    .digest("hex");
}

export function cursorStopReconstructionJobEventId(sourceRef: string): string {
  return createHash("sha256")
    .update(JSON.stringify([CURSOR_INTEGRATION, sourceRef, CURSOR_STOP_RECONSTRUCTION_EVENT_KIND]))
    .digest("hex");
}
