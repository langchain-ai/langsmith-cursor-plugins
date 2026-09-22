import type { Client } from "langsmith";
import type { Config } from "./config.js";
import { atomicUpdateState } from "./state.js";
import { reduceSweep, reduceUploadSettled } from "./reducer.js";
import { getThreadTracingMode, tracingPolicyPath } from "./tracing-policy.js";
import { debug, warn } from "./logger.js";
import { initTracing, uploadTurn } from "./langsmith.js";
import { originFromConfig } from "./turn-origin.js";
import type { HookInputBase, SweepClaim, TracingMode, TracingState, TurnMode } from "./types.js";

export interface SweepOptions {
  config: Config;
  input: HookInputBase;
  nowMs?: number;
  apply?: (state: TracingState) => TracingState;
  client?: Client;
}

export function sweepTracingMode(buffered: TurnMode | undefined, policy: TracingMode): TracingMode {
  return buffered === "metadata" ? "metadata" : policy;
}

async function uploadClaim(claim: SweepClaim, options: SweepOptions): Promise<boolean> {
  const { config, input } = options;
  const policy = getThreadTracingMode(
    tracingPolicyPath(),
    claim.conversationId,
    config.defaultMuted,
  );
  const origin = claim.buffer.origin ?? originFromConfig(config, input);
  try {
    return await uploadTurn({
      buffer: { ...claim.buffer, tracingMode: sweepTracingMode(claim.buffer.tracingMode, policy) },
      conversationId: claim.conversationId,
      turnNum: claim.turnNum,
      project: origin.project,
      userEmail: origin.userEmail,
      customMetadata: origin.customMetadata,
      runtimeVersion: origin.runtimeVersion,
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
    options.client,
  );

  const uploaded: SweepClaim[] = [];
  for (const claim of claims) {
    if (!(await uploadClaim(claim, options))) continue;
    await atomicUpdateState(config.stateFilePath, (state) =>
      reduceUploadSettled(state, claim.conversationId, claim.generationId, claim.claimedAt),
    );
    uploaded.push(claim);
  }
  return uploaded;
}
