import { dirname, join } from "node:path";
import { launchDetachedWorker, openPluginSession } from "@langchain/plugins-base/plugin";
import type { PluginSession } from "@langchain/plugins-base/plugin";
import { createRepositoryAttributor } from "@langchain/plugins-base/git";
import type { RepositoryAttributor } from "@langchain/plugins-base/git";
import { createCaptureStore } from "@langchain/plugins-base/storage/capture";
import { readSavedCaptureWake } from "@langchain/plugins-base/tracing";
import type { LifecycleCaptureInput } from "@langchain/plugins-base/tracing/lifecycle";
import type {
  ReconstructionJob,
  ReconstructionJobInput,
  ReconstructionResult,
} from "@langchain/plugins-base/tracing/reconstruction";
import { loadConfig } from "./config.js";
import type { Config } from "./models/config.js";
import { rootPatch, turnCaptures } from "./captures.js";
import {
  CAPTURE_CONFLICT_STATUS,
  CAPTURE_DUPLICATE_STATUS,
  CAPTURE_PUBLISHED_STATUS,
  ENGINE_STORAGE_DIR_NAME,
  ENGINE_WORKER_COMMAND,
  GH_LOGIN_MARKER_FILE,
  JOB_EVENT_PREFIX,
  JOB_STORE_DIR_NAME,
  LS_INTEGRATION,
  RUN_EVENT_PREFIX,
  TURN_ON_OTHER_ACCOUNT_MESSAGE,
} from "./constants.js";
import {
  finishedJobRefs,
  jobDigest,
  jobRef,
  parseJobRef,
  queuedContext,
  reduceChosenOutputs,
  reduceQueued,
  reduceUploaded,
} from "./job-context.js";
import { atomicUpdateState, readState } from "./state.js";
import { buildToolRuns, buildTurnRuns, turnRunId } from "./langsmith.js";
import type { UploadJobContext } from "./models/job-context.js";
import type { BuildTurnOptions } from "./models/langsmith.js";
import type { CaptureStatus, RecoveryReport, SavedCapture } from "./models/tracing-engine.js";
import type { ContentPart } from "./models/types.js";
import { debug, warn } from "./logger.js";
import { isRecord } from "./normalize.js";
import { toolOrigin } from "./tool-origin.js";
import { enrichTurn } from "./turn-enrichment.js";
import { withWarningsTo } from "./utils/console.js";
import { writerOptions } from "./writer-options.js";

let attributor: RepositoryAttributor | undefined;

export async function saveTurnForUpload(
  config: Config,
  context: UploadJobContext,
): Promise<boolean> {
  try {
    await queueUpload(config, context);
    return true;
  } catch (err) {
    warn(`Keeping the turn for a later retry: ${err}`);
    return false;
  }
}

export async function saveToolForUpload(
  config: Config,
  options: BuildTurnOptions,
  toolIndex: number,
  attachments: () => ContentPart[],
): Promise<void> {
  const captures = turnCaptures(buildToolRuns(options, toolIndex));
  if (captures.length === 0) return;
  const plugin = openSession(config, options.conversationId, options.project);
  try {
    const { turnId } = captures[0];
    if (await plugin.store.readSettledTurn(LS_INTEGRATION, plugin.sessionId, turnId)) return;
    const root = await readSaved(plugin, captures[0]);
    if (root && root.destinationFingerprint !== plugin.fingerprint) return;
    const withRoot = root
      ? captures
      : turnCaptures(buildToolRuns({ ...options, attachments: attachments() }, toolIndex));
    for (const input of withRoot) await captureInto(plugin, input);
  } catch (err) {
    warn(`Leaving tool ${toolIndex} for stop to save: ${err}`);
  }
}

export function wakeUploader(config: Config, conversationId: string): Promise<number> {
  return launchDetachedWorker([ENGINE_WORKER_COMMAND, config.cwd, conversationId], {
    storageRoot: storageRootFor(config),
  });
}

async function queueUpload(config: Config, context: UploadJobContext): Promise<void> {
  const plugin = openSession(config, context.conversationId, context.origin.project);
  const turnId = turnRunId(context.conversationId, context.buffer.generation_id);
  const { sessionId } = plugin;
  const saved = (runId: string) =>
    plugin.store.read({
      integration: LS_INTEGRATION,
      sessionId,
      turnId,
      eventId: `${RUN_EVENT_PREFIX}${runId}`,
    });
  const root = await saved(turnId);
  if (root && root.destinationFingerprint !== plugin.fingerprint) {
    throw new Error(TURN_ON_OTHER_ACCOUNT_MESSAGE);
  }
  const digest = jobDigest(plugin.sessionId, context);
  const savedAtMs = Date.now();
  await atomicUpdateState(config.stateFilePath, (s) => reduceQueued(s, context, savedAtMs));
  const generationId = context.buffer.generation_id;
  const ref = jobRef({ conversationId: context.conversationId, generationId, savedAtMs });
  const input: ReconstructionJobInput = {
    turnId,
    eventId: `${JOB_EVENT_PREFIX}${digest}`,
    sourceRefs: [ref],
    privacyMode: context.buffer.tracingMode === "full" ? "full" : "metadata",
    turnEvidence: { childRunIds: [], closureState: "authoritative" },
  };
  try {
    const { status } = await plugin.session.queueReconstruction(input);
    if (status !== CAPTURE_PUBLISHED_STATUS && status !== CAPTURE_DUPLICATE_STATUS) {
      throw new Error(`Could not save ${input.eventId} for upload: ${status}`);
    }
  } catch (err) {
    if (!(await plugin.session.readSavedReconstructionWake(err, input))) throw err;
    warn(`Saved ${input.eventId} for upload, but its uploader did not start: ${err}`);
  }
}

async function buildQueuedRuns(
  job: ReconstructionJob,
  config: Config,
  plugin: PluginSession,
): Promise<ReconstructionResult> {
  const ref = parseJobRef(job.sourceRefs[0]);
  const context = ref && queuedContext(readState(config.stateFilePath), ref);
  if (!ref || !context) return { status: "ready", outputs: [] };
  const { buffer, conversationId, turnNum, origin } = context;
  const cwd =
    typeof origin.customMetadata?.cwd === "string" ? origin.customMetadata.cwd : config.cwd;
  const options: BuildTurnOptions = {
    buffer,
    conversationId,
    turnNum,
    project: origin.project,
    userEmail: origin.userEmail,
    customMetadata: origin.customMetadata,
    runtimeVersion: origin.runtimeVersion,
    savedAtMs: context.savedAtMs,
  };
  const chosen = context.outputEventIds && new Set(context.outputEventIds);
  const inputs = await turnInputs(
    plugin,
    context.kind === "stop" ? enrichTurn(config, options) : options,
    chosen,
  );
  if (!chosen) {
    const outputEventIds = inputs.map(({ eventId }) => eventId);
    await atomicUpdateState(config.stateFilePath, (s) =>
      reduceChosenOutputs(s, ref, outputEventIds),
    );
  }
  const attributor = attributorFor(config);
  const toolOrigins = buffer.tools.map((tool) => toolOrigin(tool.input, cwd));
  return {
    status: "ready",
    outputs: inputs.map(({ eventId, submission, turnEvidence, dependencies }) => {
      const { metadata } = submission;
      const base =
        submission.operation === "post" && submission.run.run_type === "tool"
          ? attributor.toolMetadata(metadata.base, toolOrigin(submission.run.inputs?.input, cwd))
          : attributor.turnMetadata(metadata.base, cwd, toolOrigins);
      return {
        eventId,
        submission: { ...submission, metadata: { ...metadata, base: base ?? metadata.base } },
        turnEvidence,
        ...(dependencies ? { dependencies } : {}),
      };
    }),
  };
}

function attributorFor(config: Config): RepositoryAttributor {
  attributor ??= createRepositoryAttributor({
    githubLoginMarkerPath: join(dirname(config.stateFilePath), GH_LOGIN_MARKER_FILE),
  });
  return attributor;
}

async function turnInputs(
  plugin: PluginSession,
  options: BuildTurnOptions,
  chosen?: ReadonlySet<string>,
): Promise<LifecycleCaptureInput[]> {
  const [root, ...children] = turnCaptures(buildTurnRuns(options));
  if (!root) return [];
  if (chosen) {
    const all = [root, ...children, rootPatch(root, plugin.sessionId)];
    return all.filter(({ eventId }) => chosen.has(eventId));
  }
  const saved = await readSaved(plugin, root);
  if (saved && saved.destinationFingerprint !== plugin.fingerprint) {
    throw new Error(TURN_ON_OTHER_ACCOUNT_MESSAGE);
  }
  const inputs = saved ? [] : [root];
  for (const input of children) {
    if (!(await readSaved(plugin, input))) inputs.push(input);
  }
  const closed =
    isRecord(saved?.turnEvidence) && saved.turnEvidence.closureState === "authoritative";
  if (saved && (!closed || inputs.length === 0)) inputs.push(rootPatch(root, plugin.sessionId));
  return inputs;
}

function readSaved(plugin: PluginSession, input: LifecycleCaptureInput): Promise<SavedCapture> {
  return plugin.store.read({
    integration: LS_INTEGRATION,
    sessionId: plugin.sessionId,
    turnId: input.turnId,
    eventId: input.eventId,
  });
}

export async function runEngineWorker(
  config: Config,
  sessionId: string,
  project = config.project,
): Promise<void> {
  const built = new Map<string, string>();
  const result = await openSession(config, sessionId, project, built).session.drain();
  const refs = finishedJobRefs(built, await pendingJobs(config));
  if (refs.length > 0)
    await atomicUpdateState(config.stateFilePath, (s) => reduceUploaded(s, refs));
  if (result === "dropped") warn(`Dropped saved traces for ${sessionId} after repeated failures`);
  else if (result === "retry-exhausted" || result === "scope-mismatch") {
    warn(`The uploader for ${sessionId} stopped with ${result}`);
  } else debug(`The uploader for ${sessionId} finished with ${result}`);
}

export async function recoverConversations(
  config: Config,
  conversationId: string,
  minimumForeignAgeMs: number,
): Promise<void> {
  const plugin = openSession(config, conversationId, config.project);
  const report = await withWarningsTo(warn, () =>
    plugin.session.recoverSessions({
      optionsForSession: plugin.callbacks,
      minimumForeignAgeMs: Math.round(minimumForeignAgeMs),
      excludeCurrentSession: true,
    }),
  );
  for (const { sessionId, message } of report.failed) {
    warn(`Could not restart the uploader for ${sessionId}: ${message}`);
  }
}

async function captureInto(
  plugin: PluginSession,
  input: LifecycleCaptureInput,
): Promise<CaptureStatus> {
  try {
    const result = await plugin.session.capture(input);
    if (result.status === CAPTURE_CONFLICT_STATUS) debug(`Run ${input.eventId} was already saved`);
    else if (
      result.status !== CAPTURE_PUBLISHED_STATUS &&
      result.status !== CAPTURE_DUPLICATE_STATUS
    ) {
      throw new Error(`Could not save ${input.eventId} for upload: ${result.status}`);
    }
    return result.status;
  } catch (err) {
    const saved = await readSavedCaptureWake(err, {
      store: plugin.store,
      integration: LS_INTEGRATION,
      sessionId: plugin.sessionId,
      turnId: input.turnId,
      eventId: input.eventId,
      destinationFingerprint: plugin.fingerprint,
    });
    if (!saved) throw err;
    warn(`Saved ${input.eventId} for upload, but its uploader did not start: ${err}`);
    return CAPTURE_PUBLISHED_STATUS;
  }
}

function reportRecovery(result: RecoveryReport): void {
  if (result.status === "partial" || result.status === "failed") {
    warn(`Could not upload every older conversation: ${JSON.stringify(result)}`);
  }
}

async function pendingJobs(config: Config): Promise<Set<string>> {
  const jobs = createCaptureStore(storageRootFor(config), JOB_STORE_DIR_NAME);
  const sessions = await jobs.enumerateSessions(LS_INTEGRATION);
  return new Set(sessions.flatMap(({ captures }) => captures.map(({ record }) => record.eventId)));
}

function storageRootFor(config: Config): string {
  return join(dirname(config.stateFilePath), ENGINE_STORAGE_DIR_NAME);
}

function openSession(
  config: Config,
  sessionId: string,
  project: string,
  built?: Map<string, string>,
): PluginSession {
  const storageRoot = storageRootFor(config);
  const plugin: PluginSession = openPluginSession({
    storageRoot,
    integration: LS_INTEGRATION,
    sessionId,
    writer: writerOptions(config, project),
    currentWriter: () => writerOptions(loadConfig({ cwd: config.cwd }), project),
    scheduleWake: (id) =>
      launchDetachedWorker([ENGINE_WORKER_COMMAND, config.cwd, id, project], { storageRoot }),
    reconstruct: (job) => {
      built?.set(job.eventId, job.sourceRefs[0]);
      return buildQueuedRuns(job, config, plugin);
    },
    onRecoveryReport: reportRecovery,
  });
  return plugin;
}
