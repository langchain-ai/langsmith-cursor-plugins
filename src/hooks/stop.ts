#!/usr/bin/env node
/**
 * stop hook — finalizes the turn: posts the LangSmith trace, flushes, clears the
 * buffer. Idempotent; no buffer → no-op.
 */

import { readStdin } from "../utils/stdin.js";
import { initHook } from "../utils/hook-init.js";
import { loadConfig } from "../config.js";
import { atomicUpdateState } from "../state.js";
import { reduceStop } from "../reducer.js";
import { initTracing, buildTurnRuns, flushPendingTraces } from "../langsmith.js";
import { resolveTurnAttachments } from "../attachments.js";
import { resolveSystemPrompts } from "../system-prompt.js";
import { resolveTurnSteps } from "../conversation-steps.js";
import { error, debug, warn } from "../logger.js";
import type { ContentPart, StopInput, TurnBuffer } from "../types.js";

async function main(): Promise<void> {
  const input = await readStdin<StopInput>();
  const config = initHook(input.workspace_roots?.[0]);
  if (!config) {
    // Prompt submission records off launches even without upload credentials.
    // Consume only those snapshots; leave the pre-existing enabled-turn lifecycle alone.
    const local = loadConfig({ cwd: input.workspace_roots?.[0] });
    await atomicUpdateState(local.stateFilePath, (s) =>
      s[input.conversation_id]?.turns[input.generation_id]?.tracingMode === "off"
        ? reduceStop(s, input, Date.now()).state
        : s,
    );
    return;
  }

  debug(`stop conv=${input.conversation_id} gen=${input.generation_id} status=${input.status}`);
  let toTrace: TurnBuffer | undefined;
  let turnNum = 0;

  await atomicUpdateState(config.stateFilePath, (s) => {
    const r = reduceStop(s, input, Date.now());
    toTrace = r.buffer;
    turnNum = r.turnNum;
    return r.state;
  });

  if (!toTrace) {
    debug("No buffered turn for this generation — nothing to trace");
    return;
  }

  if (toTrace.tracingMode === "off") return;

  initTracing(
    config.apiKey,
    config.apiUrl,
    config.replicas,
    config.redact,
    config.redactExtraRules,
  );

  // Best-effort attachment enrichment (read-only DB + disk); never throws, and an
  // empty result leaves the turn unchanged.
  let attachments: ContentPart[] = [];
  if (config.attachmentsEnabled && toTrace.tracingMode === "full") {
    attachments = resolveTurnAttachments({
      conversationId: input.conversation_id,
      prompt: toTrace.prompt,
      dbPath: config.cursorDbPath,
    });
  }

  // Best-effort system-prompt enrichment (read-only DB + protobuf field decode);
  // never throws, and undefined leaves the llm runs unchanged.
  let systemPrompt: string | undefined;
  if (config.systemPromptEnabled && toTrace.tracingMode === "full") {
    // Resolve the main turn + every subagent's child conversation over ONE DB
    // connection (avoids an open-per-subagent explosion with many subagents).
    const childIds = toTrace.subagents
      .map((s) => s.childConversationId)
      .filter((id): id is string => !!id);
    const prompts = resolveSystemPrompts({
      conversationIds: [input.conversation_id, ...childIds],
      dbPath: config.cursorDbPath,
    });
    systemPrompt = prompts.get(input.conversation_id);
    for (const sub of toTrace.subagents) {
      if (sub.childConversationId) sub.systemPrompt = prompts.get(sub.childConversationId);
    }
  }

  // Best-effort interleaved step fidelity; undefined falls back to the hook-built shape.
  const steps = resolveTurnSteps({
    conversationId: input.conversation_id,
    toolUseIds: toTrace.tools.map((t) => t.tool_use_id),
    dbPath: config.cursorDbPath,
  });

  try {
    await buildTurnRuns({
      buffer: toTrace,
      conversationId: input.conversation_id,
      turnNum,
      project: config.project,
      userEmail: input.user_email,
      workspaceRoots: input.workspace_roots,
      customMetadata: config.customMetadata,
      runtimeVersion: input.cursor_version,
      attachments,
      systemPrompt,
      steps,
    });
  } catch (err) {
    error(`Failed to build turn runs: ${err}`);
  }

  await flushPendingTraces();
}

export const completion = main().catch((err) => {
  try {
    warn(`stop hook error: ${err}`);
  } catch {
    /* last resort */
  }
  // Non-zero exit (never 2 = "block") tells Cursor the hook failed.
  process.exitCode = 1;
});
