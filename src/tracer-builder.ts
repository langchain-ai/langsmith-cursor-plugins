import type {
  CreateTranscriptBuilder,
  HookNote,
  RunPatch,
  RunPost,
} from "@langchain/plugins-base/tracer";
import { metadataWithInherited } from "./captures.js";
import { CONVERSATION_MAX_AGE_MS } from "./constants.js";
import { addedLiveTool } from "./hooks/tool-hook.js";
import { buildToolRuns, buildTurnRuns, turnRunId } from "./langsmith.js";
import {
  reduceAfterAgentResponse,
  reduceAfterAgentThought,
  reduceBeforeSubmitPrompt,
  reducePostToolUse,
  reducePostToolUseFailure,
  reduceSavedForUpload,
  reduceStop,
  reduceSubagentStart,
  reduceSubagentStop,
  reduceSweep,
} from "./reducer.js";
import { pruneOldConversations } from "./state.js";
import { resolveSubagentTranscript } from "./subagent-transcript.js";
import { sweepTracingMode } from "./sweep.js";
import { BUILDER_STATE_VERSION, NOTE_EVENTS } from "./tracer-builder-constants.js";
import { repositoryMetadata } from "./tracing-engine.js";
import {
  getThreadTracingMode,
  mutingLocked,
  tracingPolicyPath,
  withLockedMute,
} from "./tracing-policy.js";
import { enrichTurn, toolAttachments, withTurnHooks } from "./turn-enrichment.js";
import { isoTime } from "./utils/time.js";
import type { BuildTurnOptions } from "./models/langsmith.js";
import type {
  BuilderSettings,
  BuilderState,
  NoteDetails,
  TurnToSend,
} from "./models/tracer-builder.js";
import type { CapturedRun, RepositoryBase } from "./models/tracing-engine.js";
import type {
  AfterAgentResponseInput,
  AfterAgentThoughtInput,
  BeforeSubmitPromptInput,
  PostToolUseFailureInput,
  PostToolUseInput,
  StopInput,
  SubagentStartInput,
  SubagentStopInput,
  TurnBuffer,
  TurnOrigin,
} from "./models/types.js";

function restoredState(saved: unknown): BuilderState {
  const candidate = saved as Partial<BuilderState> | undefined;
  return candidate?.version === BUILDER_STATE_VERSION
    ? (candidate as BuilderState)
    : { version: BUILDER_STATE_VERSION, tracing: {}, posted: {} };
}

export const createTranscriptBuilder: CreateTranscriptBuilder = ({ savedState, sink }) => {
  const state = restoredState(savedState);

  function runPost(captured: CapturedRun, repositoryBase: RepositoryBase): RunPost {
    const { run, mode } = captured;
    const metadata = metadataWithInherited(captured);
    const tool =
      run.run_type === "tool"
        ? { input: run.inputs?.input, toolUseId: metadata.runSpecific?.tool_use_id }
        : undefined;
    return {
      id: run.id,
      name: run.name,
      run_type: run.run_type,
      trace_id: run.trace_id,
      dotted_order: run.dotted_order,
      ...(run.parent_run === undefined ? {} : { parent_run_id: run.parent_run.id }),
      start_time: isoTime(run.start_time),
      ...(run.end_time === undefined ? {} : { end_time: isoTime(run.end_time) }),
      inputs: run.inputs,
      ...(run.outputs === undefined ? {} : { outputs: run.outputs }),
      ...(run.error === undefined ? {} : { error: run.error }),
      metadata: { ...metadata, base: repositoryBase(metadata.base, tool) ?? metadata.base },
      tracingMode: mode,
    };
  }

  function post(captured: CapturedRun, repositoryBase: RepositoryBase, nowMs: number): void {
    const run = runPost(captured, repositoryBase);
    sink.post(run);
    state.posted[run.id] = { postedAtMs: nowMs, closed: run.end_time !== undefined };
  }

  function patchRoot(root: CapturedRun, repositoryBase: RepositoryBase): void {
    const { inputs: _inputs, ...run } = runPost(root, repositoryBase);
    const patch: RunPatch = run;
    sink.patch(patch);
  }

  function turnOptions(
    conversationId: string,
    buffer: TurnBuffer,
    turnNum: number,
    origin: TurnOrigin,
  ): BuildTurnOptions {
    return {
      buffer,
      conversationId,
      turnNum,
      project: origin.project,
      userEmail: origin.userEmail,
      customMetadata: origin.customMetadata,
      runtimeVersion: origin.runtimeVersion,
    };
  }

  function turnRepositoryBase(buffer: TurnBuffer, origin: TurnOrigin, settings: BuilderSettings) {
    const cwd =
      typeof origin.customMetadata?.cwd === "string" ? origin.customMetadata.cwd : settings.cwd;
    return repositoryMetadata(settings, buffer, cwd);
  }

  function sendTurn(turn: TurnToSend, details: NoteDetails): void {
    const { settings } = details;
    const buffer = withLockedMute(turn.buffer, settings);
    const options: BuildTurnOptions = {
      ...turnOptions(turn.conversationId, buffer, turn.turnNum, turn.origin),
      savedAtMs: turn.savedAtMs,
    };
    const built = withTurnHooks(settings, turn.enrich ? enrichTurn(settings, options) : options);
    const repositoryBase = turnRepositoryBase(buffer, turn.origin, settings);
    const [root, ...children] = buildTurnRuns(built);
    if (root === undefined) return;
    const saved = state.posted[root.run.id];
    if (saved === undefined) post(root, repositoryBase, details.time);
    let posted = 0;
    for (const child of children) {
      if (state.posted[child.run.id] !== undefined) continue;
      post(child, repositoryBase, details.time);
      posted += 1;
    }
    if (saved !== undefined && (!saved.closed || posted === 0)) patchRoot(root, repositoryBase);
  }

  function sendLiveTool(input: PostToolUseInput | PostToolUseFailureInput, details: NoteDetails) {
    const live = addedLiveTool(state.tracing, input);
    if (live === undefined || details.settings.captureHookOutputs) return;
    const { settings } = details;
    const buffer = withLockedMute(live.buffer, settings);
    const origin = buffer.origin ?? details.origin;
    const options = turnOptions(input.conversation_id, buffer, live.turnNum, origin);
    const rootPost = state.posted[turnRunId(input.conversation_id, buffer.generation_id)];
    const enriched =
      rootPost === undefined
        ? { ...options, attachments: toolAttachments(settings, options) }
        : options;
    const repositoryBase = turnRepositoryBase(buffer, origin, settings);
    for (const captured of buildToolRuns(enriched, live.toolIndex))
      if (state.posted[captured.run.id] === undefined) post(captured, repositoryBase, details.time);
  }

  function stopTurn(input: StopInput, details: NoteDetails): void {
    const { state: next, buffer, turnNum } = reduceStop(state.tracing, input, details.time);
    state.tracing = next;
    if (buffer === undefined) return;
    const { conversation_id: conversationId, generation_id: generationId } = input;
    const origin = details.origin;
    sendTurn(
      { conversationId, buffer, turnNum, origin, savedAtMs: details.time, enrich: true },
      details,
    );
    state.tracing = reduceSavedForUpload(state.tracing, conversationId, generationId, details.time);
  }

  function sweepIdleTurns(callerConversationId: string, details: NoteDetails): void {
    const { settings, time } = details;
    const { state: next, claims } = reduceSweep(
      pruneOldConversations(state.tracing, time),
      callerConversationId,
      time,
      settings.sweepIdleMinutes * 60_000,
    );
    state.tracing = next;
    for (const claim of claims) {
      const policy = getThreadTracingMode(
        tracingPolicyPath(),
        claim.conversationId,
        settings.defaultMuted,
        mutingLocked(settings),
      );
      const tracingMode = sweepTracingMode(claim.buffer.tracingMode, policy);
      sendTurn(
        {
          conversationId: claim.conversationId,
          buffer: { ...claim.buffer, tracingMode },
          turnNum: claim.turnNum,
          origin: claim.buffer.origin ?? details.origin,
          savedAtMs: time,
          enrich: false,
        },
        details,
      );
      state.tracing = reduceSavedForUpload(
        state.tracing,
        claim.conversationId,
        claim.generationId,
        claim.claimedAt,
      );
    }
  }

  function forgetOldPosts(nowMs: number): void {
    for (const [id, posted] of Object.entries(state.posted))
      if (nowMs - posted.postedAtMs > CONVERSATION_MAX_AGE_MS) delete state.posted[id];
  }

  function applyNote(event: string, details: NoteDetails, mode: HookNote["tracingMode"]): void {
    const { time } = details;
    const tracing = state.tracing;
    switch (event) {
      case NOTE_EVENTS.beforeSubmitPrompt: {
        const input = details.input as BeforeSubmitPromptInput;
        state.tracing = reduceBeforeSubmitPrompt(tracing, input, time, mode, details.origin);
        return;
      }
      case NOTE_EVENTS.postToolUse: {
        const input = details.input as PostToolUseInput;
        state.tracing = reducePostToolUse(tracing, input, time);
        sendLiveTool(input, details);
        return;
      }
      case NOTE_EVENTS.postToolUseFailure: {
        const input = details.input as PostToolUseFailureInput;
        state.tracing = reducePostToolUseFailure(tracing, input, time);
        sendLiveTool(input, details);
        return;
      }
      case NOTE_EVENTS.afterAgentResponse:
        state.tracing = reduceAfterAgentResponse(
          tracing,
          details.input as AfterAgentResponseInput,
          time,
        );
        return;
      case NOTE_EVENTS.afterAgentThought:
        state.tracing = reduceAfterAgentThought(tracing, details.input as AfterAgentThoughtInput);
        return;
      case NOTE_EVENTS.subagentStart:
        state.tracing = reduceSubagentStart(tracing, details.input as SubagentStartInput, time);
        return;
      case NOTE_EVENTS.subagentStop: {
        const input = details.input as SubagentStopInput;
        const resolved = resolveSubagentTranscript(input.transcript_path, input.task);
        state.tracing = reduceSubagentStop(tracing, input, time, resolved);
        return;
      }
      case NOTE_EVENTS.stop:
        stopTurn(details.input as StopInput, details);
        return;
    }
  }

  return {
    lineId: () => undefined,
    readLine: () => undefined,
    transcripts: () => [],
    state: () => state,
    receiveNote: (note) => {
      const details = note.details as NoteDetails;
      applyNote(note.event, details, note.tracingMode);
      sweepIdleTurns(details.input.conversation_id, details);
      forgetOldPosts(details.time);
    },
  };
};
