#!/usr/bin/env node
/**
 * stop hook — finalizes the turn: posts the LangSmith trace, flushes, clears the
 * buffer. Idempotent. A turn stays pending until its upload succeeds, and every
 * run also sweeps up turns other threads left buffered with no stop.
 */

import { join } from "node:path";
import { readStdin } from "../utils/stdin.js";
import { initHook } from "../utils/hook-init.js";
import { loadConfig } from "../config.js";
import { atomicUpdateState, getTurnBuffer, ownEntry } from "../state.js";
import { reduceStop, reduceUploadSettled } from "../reducer.js";
import { runSweep } from "../sweep.js";
import { CaptureWakeError, readSavedCaptureWake } from "@langchain/plugins-base/tracing";
import { createCaptureStore } from "@langchain/plugins-base/storage/capture";
import {
  createCursorTracingSession,
  cursorStopReconstructionJobEventId,
  parseCursorEngineWorkerArguments,
  runCursorEngineWorker,
} from "../tracing-engine.js";
import { originFromConfig } from "../turn-origin.js";
import { captureCursorNativeTurnSource } from "../native-turn-source.js";
import {
  CURSOR_ENGINE_WORKER_FLAG,
  CURSOR_INTEGRATION,
  CURSOR_RECONSTRUCTION_DIRECTORY,
  CURSOR_STOP_SOURCE_EVENT_ID,
} from "../constants.js";
import { debug, warn } from "../logger.js";
import type { StopInput, TracingState, TurnBuffer } from "../types.js";

async function main(): Promise<void> {
  const input = await readStdin<StopInput>();
  const config = initHook(input.workspace_roots?.[0]);
  if (!config) {
    // Prompt submission records off launches even without upload credentials.
    // Consume only those snapshots; leave the pre-existing enabled-turn lifecycle alone.
    const local = loadConfig({ cwd: input.workspace_roots?.[0] });
    await atomicUpdateState(local.stateFilePath, (s) =>
      getTurnBuffer(s, input.conversation_id, input.generation_id)?.tracingMode === "off"
        ? reduceStop(s, input, Date.now()).state
        : s,
    );
    return;
  }

  debug(`stop conv=${input.conversation_id} gen=${input.generation_id} status=${input.status}`);
  const finalizedAt = Date.now();
  let toTrace: TurnBuffer | undefined;
  let turnNum = 0;
  let handoffClaimedAt = finalizedAt;

  await atomicUpdateState(config.stateFilePath, (s) => {
    const pending = ownEntry(ownEntry(s, input.conversation_id)?.pending, input.generation_id);
    const r = reduceStop(s, input, finalizedAt);
    toTrace = r.buffer ?? pending?.buffer;
    turnNum = r.buffer ? r.turnNum : (pending?.turnNum ?? r.turnNum);
    handoffClaimedAt = pending?.claimedAt ?? finalizedAt;
    return r.state;
  });

  const clearThisTurnsPendingUpload = (s: TracingState) =>
    reduceUploadSettled(s, input.conversation_id, input.generation_id, handoffClaimedAt);
  const sweep = (apply?: (s: TracingState) => TracingState) => runSweep({ config, input, apply });

  if (!toTrace) {
    debug("No buffered turn for this generation — nothing to trace");
    await sweep();
    return;
  }

  if (toTrace.tracingMode === "off") {
    await sweep();
    return;
  }

  const sessionId = input.session_id ?? input.conversation_id;
  const origin = toTrace.origin ?? originFromConfig(config, input);
  const routeCwd =
    typeof origin.customMetadata?.cwd === "string"
      ? origin.customMetadata.cwd
      : input.workspace_roots?.[0];
  const tracingSession = createCursorTracingSession(
    config,
    sessionId,
    routeCwd,
    undefined,
    origin.project,
  );
  if (!tracingSession) throw new Error("Shared trace capture is unavailable");
  const persisted = await captureCursorNativeTurnSource({
    storageRoot: tracingSession.storageRoot,
    accountFingerprint: tracingSession.destinationFingerprint,
    sessionId,
    conversationId: input.conversation_id,
    sourceEventId: CURSOR_STOP_SOURCE_EVENT_ID,
    turnNum,
    buffer: toTrace,
    cwd: routeCwd,
  });
  const jobEventId = cursorStopReconstructionJobEventId(persisted.sourceRef);
  const jobResult = await (async () => {
    try {
      return await tracingSession.session.queueReconstruction({
        turnId: input.generation_id,
        eventId: jobEventId,
        sourceRefs: [persisted.sourceRef],
        privacyMode: persisted.source.buffer.tracingMode === "full" ? "full" : "metadata",
        turnEvidence: { childRunIds: [], closureState: "authoritative" },
        sourceAgeStartedAtMs: persisted.source.buffer.startMs,
      });
    } catch (err) {
      if (!(err instanceof CaptureWakeError)) throw err;
      const saved = await readSavedCaptureWake(err, {
        store: createCaptureStore(
          join(tracingSession.storageRoot, CURSOR_RECONSTRUCTION_DIRECTORY),
        ),
        integration: CURSOR_INTEGRATION,
        sessionId,
        turnId: input.generation_id,
        destinationFingerprint: tracingSession.destinationFingerprint,
        eventId: jobEventId,
      });
      if (!saved) throw err;
      return saved;
    }
  })();
  if (jobResult.status !== "published" && jobResult.status !== "duplicate") {
    throw new Error(`Could not queue Cursor turn reconstruction: ${jobResult.status}`);
  }
  await atomicUpdateState(config.stateFilePath, clearThisTurnsPendingUpload);
  await sweep();
}

async function runEngineWorker(): Promise<void> {
  const worker = parseCursorEngineWorkerArguments(process.argv.slice(3));
  await runCursorEngineWorker(worker.sessionId, worker.cwd, worker.project);
}

export const finished =
  process.argv[2] === CURSOR_ENGINE_WORKER_FLAG
    ? runEngineWorker().catch((err) => {
        warn(`Trace worker failed: ${String(err)}`);
        process.exitCode = 1;
      })
    : main().catch((err) => {
        try {
          warn(`stop hook error: ${err}`);
        } catch {
          /* last resort */
        }
        process.exit(0);
      });
