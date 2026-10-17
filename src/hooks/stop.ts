/**
 * stop hook — finalizes the turn: saves the LangSmith trace for upload, clears the
 * buffer. Idempotent. A turn stays pending until its trace is saved, and every
 * run also sweeps up turns other threads left buffered with no stop.
 */

import { readStdin } from "../utils/stdin.js";
import { initHook } from "../utils/hook-init.js";
import { loadConfig } from "../config.js";
import { atomicUpdateState, getTurnBuffer } from "../state.js";
import { reduceStop, reduceSavedForUpload } from "../reducer.js";
import { saveTurnForUpload, wakeUploader } from "../tracing-engine.js";
import { originFromConfig } from "../turn-origin.js";
import { debug } from "../logger.js";
import type { StopInput, TurnBuffer } from "../models/types.js";

export async function run(): Promise<void> {
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

  await atomicUpdateState(config.stateFilePath, (s) => {
    const r = reduceStop(s, input, finalizedAt);
    toTrace = r.buffer;
    turnNum = r.turnNum;
    return r.state;
  });

  if (!toTrace) debug("No buffered turn for this generation — nothing to trace");
  const saved =
    toTrace !== undefined &&
    toTrace.tracingMode !== "off" &&
    (await saveTurnForUpload(config, {
      kind: "stop",
      conversationId: input.conversation_id,
      turnNum,
      buffer: toTrace,
      origin: originFromConfig(config, input),
    }));

  if (!saved) {
    await wakeUploader(config, input.conversation_id);
    return;
  }
  await atomicUpdateState(config.stateFilePath, (s) =>
    reduceSavedForUpload(s, input.conversation_id, input.generation_id, finalizedAt),
  );
}
