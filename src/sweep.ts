import { atomicUpdateState } from "./state.js";
import { reduceSweep, reduceSavedForUpload } from "./reducer.js";
import { getThreadTracingMode, mutingLocked, tracingPolicyPath } from "./tracing-policy.js";
import { debug, warn } from "./logger.js";
import { recoverConversations, saveTurnForUpload } from "./tracing-engine.js";
import { originFromConfig } from "./turn-origin.js";
import type { SweepClaim, TracingMode, TurnMode } from "./models/types.js";
import type { Config } from "./models/config.js";
import type { SweepOptions } from "./models/sweep.js";

function sweepTracingMode(buffered: TurnMode | undefined, policy: TracingMode): TracingMode {
  return buffered === "metadata" ? "metadata" : policy;
}

async function saveClaimForUpload(claim: SweepClaim, config: Config): Promise<boolean> {
  const policy = getThreadTracingMode(
    tracingPolicyPath(),
    claim.conversationId,
    config.defaultMuted,
    mutingLocked(config),
  );
  return saveTurnForUpload(config, {
    kind: "sweep",
    conversationId: claim.conversationId,
    turnNum: claim.turnNum,
    buffer: { ...claim.buffer, tracingMode: sweepTracingMode(claim.buffer.tracingMode, policy) },
    origin: claim.buffer.origin ?? originFromConfig(config, {}),
  });
}

export async function runSweep(options: SweepOptions): Promise<SweepClaim[]> {
  const { config, apply } = options;
  const nowMs = options.nowMs ?? Date.now();
  const thresholdMs = config.sweepIdleMinutes * 60_000;
  let claims: SweepClaim[] = [];

  await atomicUpdateState(config.stateFilePath, (state) => {
    const result = reduceSweep(
      apply ? apply(state) : state,
      options.conversationId,
      nowMs,
      thresholdMs,
    );
    claims = result.claims;
    return result.state;
  });
  try {
    await recoverConversations(config, options.conversationId, thresholdMs);
  } catch (err) {
    warn(`Could not check older conversations for saved traces: ${err}`);
  }
  if (claims.length === 0) return [];

  debug(`sweep claimed ${claims.length} abandoned turn(s)`);
  const saved: SweepClaim[] = [];
  for (const claim of claims) {
    if (!(await saveClaimForUpload(claim, config))) continue;
    await atomicUpdateState(config.stateFilePath, (state) =>
      reduceSavedForUpload(state, claim.conversationId, claim.generationId, claim.claimedAt),
    );
    saved.push(claim);
  }
  return saved;
}
