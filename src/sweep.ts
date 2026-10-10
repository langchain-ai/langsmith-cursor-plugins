import type { Config } from "./config.js";
import { atomicUpdateState } from "./state.js";
import { reduceSweep, reduceUploadSettled } from "./reducer.js";
import { getThreadTracingMode, tracingPolicyPath } from "./tracing-policy.js";
import { debug, warn } from "./logger.js";
import { initTracing, uploadTurn } from "./langsmith.js";
import type { TracingEngineTurnContext } from "./models/tracing-engine.js";
import {
  mergeCursorEarlyToolBuffer,
  readCursorEarlyNativeTurnSources,
} from "./native-turn-source.js";
import { resolveTurnOriginRoute } from "./turn-origin.js";
import { createCursorTracingSession } from "./tracing-engine.js";
import { CURSOR_TURN_ORIGIN_ERRORS } from "./constants.js";
import type { HookInputBase, SweepClaim, TracingMode, TracingState, TurnMode } from "./types.js";

export interface SweepOptions {
  config: Config;
  input: HookInputBase;
  nowMs?: number;
  apply?: (state: TracingState) => TracingState;
}

export function sweepTracingMode(buffered: TurnMode | undefined, policy: TracingMode): TracingMode {
  return buffered === "metadata" ? "metadata" : policy;
}

async function uploadClaim(claim: SweepClaim): Promise<boolean> {
  try {
    const origin = claim.buffer.origin;
    const route = resolveTurnOriginRoute(origin, claim.conversationId);
    const { config: routedConfig, sessionId, origin: routedOrigin } = route;
    const tracingSession = createCursorTracingSession(
      routedConfig,
      sessionId,
      route.cwd,
      undefined,
      routedOrigin.project,
    );
    if (!tracingSession || tracingSession.destinationFingerprint !== route.destinationFingerprint) {
      throw new Error(CURSOR_TURN_ORIGIN_ERRORS.destinationChanged);
    }
    const policy = getThreadTracingMode(
      tracingPolicyPath(),
      claim.conversationId,
      routedConfig.defaultMuted,
    );
    const tracingEngine: TracingEngineTurnContext = {
      ...tracingSession,
      sessionId,
      closureState: "provisional",
    };
    const earlySources = await readCursorEarlyNativeTurnSources(
      tracingSession.storageRoot,
      sessionId,
      claim.generationId,
      claim.conversationId,
      tracingSession.destinationFingerprint,
    );
    const buffer = mergeCursorEarlyToolBuffer(claim.conversationId, claim.buffer, earlySources);
    return await uploadTurn({
      buffer: { ...buffer, tracingMode: sweepTracingMode(buffer.tracingMode, policy) },
      conversationId: claim.conversationId,
      turnNum: claim.turnNum,
      project: routedOrigin.project,
      userEmail: routedOrigin.userEmail,
      customMetadata: routedOrigin.customMetadata,
      runtimeVersion: routedOrigin.runtimeVersion,
      tracingEngine,
    });
  } catch (err) {
    warn(`Sweep could not upload turn ${claim.turnNum} of ${claim.conversationId}: ${err}`);
    return false;
  }
}

export async function runSweep(options: SweepOptions): Promise<SweepClaim[]> {
  const { config, apply } = options;
  const nowMs = options.nowMs ?? Date.now();
  const thresholdMs = config.sweepIdleMinutes * 60_000;
  let claims: SweepClaim[] = [];

  await atomicUpdateState(config.stateFilePath, (state) => {
    const result = reduceSweep(
      apply ? apply(state) : state,
      options.input.conversation_id,
      nowMs,
      thresholdMs,
    );
    claims = result.claims;
    return result.state;
  });
  if (claims.length === 0) return [];

  debug(`sweep claimed ${claims.length} abandoned turn(s)`);
  initTracing(
    config.apiKey,
    config.apiUrl,
    config.replicas,
    config.redact,
    config.redactExtraRules,
  );
  const uploaded: SweepClaim[] = [];
  for (const claim of claims) {
    if (!(await uploadClaim(claim))) continue;
    await atomicUpdateState(config.stateFilePath, (state) =>
      reduceUploadSettled(state, claim.conversationId, claim.generationId, claim.claimedAt),
    );
    uploaded.push(claim);
  }
  return uploaded;
}
