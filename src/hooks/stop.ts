#!/usr/bin/env node
/**
 * stop hook — finalizes the turn: posts the LangSmith trace, flushes, clears the
 * buffer. Idempotent. A turn stays pending until its upload succeeds, and every
 * run also sweeps up turns other threads left buffered with no stop.
 */

import { readStdin } from "../utils/stdin.js";
import { initHook } from "../utils/hook-init.js";
import { loadConfig } from "../config.js";
import { atomicUpdateState, getTurnBuffer, ownEntry } from "../state.js";
import { reduceStop, reduceUploadSettled } from "../reducer.js";
import { CaptureWakeError } from "@langchain/plugins-base/tracing";
import {
  cursorStopReconstructionJobEventId,
  createCursorTracingSession,
  launchCursorSweepWorker,
  parseCursorEngineWorkerArguments,
  runCursorEngineWorker,
} from "../tracing-engine.js";
import { resolveTurnOriginRoute } from "../turn-origin.js";
import { captureCursorNativeTurnSource } from "../native-turn-source.js";
import {
  CURSOR_ENGINE_WORKER_FLAG,
  CURSOR_RECONSTRUCTION_ERRORS,
  CURSOR_STOP_SOURCE_EVENT_ID,
  CURSOR_TURN_ORIGIN_ERRORS,
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
  const sweep = () => launchCursorSweepWorker(config, input);

  if (!toTrace) {
    debug("No buffered turn for this generation — nothing to trace");
    await sweep();
    return;
  }

  if (toTrace.tracingMode === "off") {
    await sweep();
    return;
  }

  try {
    const origin = toTrace.origin;
    const route = resolveTurnOriginRoute(origin, input.session_id ?? input.conversation_id);
    const { config: routedConfig, sessionId, cwd: routeCwd } = route;
    const tracingSession = createCursorTracingSession(
      routedConfig,
      sessionId,
      routeCwd,
      undefined,
      origin?.project,
    );
    if (!tracingSession || tracingSession.destinationFingerprint !== route.destinationFingerprint) {
      throw new Error(CURSOR_TURN_ORIGIN_ERRORS.destinationChanged);
    }
    const persisted = await captureCursorNativeTurnSource({
      storageRoot: route.storageRoot,
      accountFingerprint: route.destinationFingerprint,
      sessionId,
      conversationId: input.conversation_id,
      sourceEventId: CURSOR_STOP_SOURCE_EVENT_ID,
      turnNum,
      buffer: toTrace,
      cwd: routeCwd,
    });
    const jobEventId = cursorStopReconstructionJobEventId(persisted.sourceRef);
    const jobInput = {
      turnId: input.generation_id,
      eventId: jobEventId,
      sourceRefs: [persisted.sourceRef],
      privacyMode: (persisted.source.buffer.tracingMode === "full" ? "full" : "metadata") as
        | "full"
        | "metadata",
      turnEvidence: { childRunIds: [], closureState: "authoritative" as const },
      sourceAgeStartedAtMs: persisted.source.buffer.startMs,
    };
    const jobResult = await (async () => {
      try {
        return await tracingSession.session.queueReconstruction(jobInput);
      } catch (err) {
        if (!(err instanceof CaptureWakeError)) throw err;
        const saved = await tracingSession.session.readSavedReconstructionWake(err, jobInput);
        if (!saved) throw err;
        return saved;
      }
    })();
    if (jobResult.status !== "published" && jobResult.status !== "duplicate") {
      throw new Error(`${CURSOR_RECONSTRUCTION_ERRORS.queueFailure}${jobResult.status}`);
    }
    await atomicUpdateState(config.stateFilePath, clearThisTurnsPendingUpload);
  } finally {
    await sweep();
  }
}

async function runEngineWorker(): Promise<void> {
  const worker = parseCursorEngineWorkerArguments(process.argv.slice(3));
  await runCursorEngineWorker(worker);
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
