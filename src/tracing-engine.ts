import { dirname, join } from "node:path";
import { launchDetachedWorker, openPluginSession } from "@langchain/plugins-base/plugin";
import type { PluginSession } from "@langchain/plugins-base/plugin";
import { readSavedCaptureWake } from "@langchain/plugins-base/tracing";
import type { LifecycleCaptureInput } from "@langchain/plugins-base/tracing/lifecycle";
import { loadConfig } from "./config.js";
import type { Config } from "./models/config.js";
import { rootPatch, turnCaptures } from "./captures.js";
import {
  CAPTURE_CONFLICT_STATUS,
  CAPTURE_DUPLICATE_STATUS,
  CAPTURE_PUBLISHED_STATUS,
  ENGINE_STORAGE_DIR_NAME,
  ENGINE_WORKER_COMMAND,
  LS_INTEGRATION,
  TURN_ON_OTHER_ACCOUNT_MESSAGE,
} from "./constants.js";
import { buildToolRuns, buildTurnRuns } from "./langsmith.js";
import type { BuildTurnOptions } from "./models/langsmith.js";
import type { CaptureStatus, RecoveryReport, SavedCapture } from "./models/tracing-engine.js";
import type { ContentPart } from "./models/types.js";
import { debug, warn } from "./logger.js";
import { isRecord } from "./normalize.js";
import { withWarningsTo } from "./utils/console.js";
import { noReconstruction } from "./reconstruction.js";
import { writerOptions } from "./writer-options.js";

export async function saveTurnForUpload(
  config: Config,
  options: BuildTurnOptions,
): Promise<boolean> {
  const captures = turnCaptures(buildTurnRuns(options));
  if (captures.length === 0) return true;
  const plugin = openSession(config, options.conversationId, options.project);
  try {
    const [root, ...children] = captures;
    const saved = await readSaved(plugin, root);
    if (saved && saved.destinationFingerprint !== plugin.fingerprint) {
      throw new Error(TURN_ON_OTHER_ACCOUNT_MESSAGE);
    }
    const closeLater = await saveRootUnlessOpen(plugin, root);
    for (const input of children) {
      if (!(await readSaved(plugin, input))) await captureInto(plugin, input);
    }
    if (closeLater) await captureInto(plugin, rootPatch(root, plugin.sessionId));
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

async function saveRootUnlessOpen(
  plugin: PluginSession,
  input: LifecycleCaptureInput,
): Promise<boolean> {
  if (
    !(await readSaved(plugin, input)) &&
    (await captureInto(plugin, input)) !== CAPTURE_CONFLICT_STATUS
  )
    return false;
  const saved = await readSaved(plugin, input);
  return !(isRecord(saved?.turnEvidence) && saved.turnEvidence.closureState === "authoritative");
}

function readSaved(plugin: PluginSession, input: LifecycleCaptureInput): Promise<SavedCapture> {
  return plugin.store.read({
    integration: LS_INTEGRATION,
    sessionId: plugin.sessionId,
    turnId: input.turnId,
    eventId: input.eventId,
  });
}

export async function runEngineWorker(config: Config, sessionId: string): Promise<void> {
  const result = await openSession(config, sessionId, config.project).session.drain();
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

function openSession(config: Config, sessionId: string, project: string): PluginSession {
  const storageRoot = join(dirname(config.stateFilePath), ENGINE_STORAGE_DIR_NAME);
  return openPluginSession({
    storageRoot,
    integration: LS_INTEGRATION,
    sessionId,
    writer: writerOptions(config, project),
    currentWriter: () => writerOptions(loadConfig({ cwd: config.cwd }), project),
    scheduleWake: (id) =>
      launchDetachedWorker([ENGINE_WORKER_COMMAND, config.cwd, id], { storageRoot }),
    reconstruct: noReconstruction,
    onRecoveryReport: reportRecovery,
  });
}
