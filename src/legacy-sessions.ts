import { homedir } from "node:os";
import { join } from "node:path";
import { createCaptureStore } from "@langchain/plugins-base/storage/capture";
import type { LegacySession } from "@langchain/plugins-base/tracer";
import {
  AGENT_TRANSCRIPTS_FOLDER,
  CURSOR_DIRECTORY_NAME,
  CURSOR_PROJECTS_FOLDER,
  LS_INTEGRATION,
  RUN_POST_EVENT_KIND,
  TRANSCRIPT_EXTENSION,
  WORKSPACE_FOLDER_SEPARATORS,
} from "./constants.js";
import { turnRunId } from "./langsmith.js";
import { readState } from "./state.js";
import { emptyBuilderState } from "./tracer-builder.js";
import { runEngineWorker } from "./tracing-engine.js";
import { storageRootFor, writerOptions } from "./writer-options.js";
import type { Config } from "./models/config.js";
import type { BuilderState } from "./models/tracer-builder.js";
import type { ConversationState, SeededSession, SentRuns, TurnOrigin } from "./models/types.js";

function savedOrigin(conversation: ConversationState): TurnOrigin | undefined {
  const turns = Object.values(conversation.turns);
  const pending = Object.values(conversation.pending ?? {}).map((entry) => entry.buffer);
  const queued = Object.values(conversation.queued ?? {});
  return [...queued, ...pending, ...turns].find((saved) => saved.origin)?.origin;
}

function savedWorkspace(conversation: ConversationState): string | undefined {
  const cwd = savedOrigin(conversation)?.customMetadata?.cwd;
  return typeof cwd === "string" ? cwd : undefined;
}

function transcriptPath(workspace: string, conversationId: string): string {
  const folder = workspace.split(WORKSPACE_FOLDER_SEPARATORS).filter(Boolean).join("-");
  return join(
    homedir(),
    CURSOR_DIRECTORY_NAME,
    CURSOR_PROJECTS_FOLDER,
    folder,
    AGENT_TRANSCRIPTS_FOLDER,
    conversationId,
    `${conversationId}${TRANSCRIPT_EXTENSION}`,
  );
}

async function oldRunsSent(config: Config, conversationId: string, rootRunId: string) {
  const store = createCaptureStore(storageRootFor(config));
  const turn = await store.enumerateTurn(LS_INTEGRATION, conversationId, rootRunId).catch(() => []);
  return turn
    .map(({ record }) => record)
    .filter(
      ({ eventKind, runId, delivery }) =>
        eventKind === RUN_POST_EVENT_KIND &&
        (runId === rootRunId || Object.keys(delivery?.outcomes ?? {}).length > 0),
    )
    .map(({ runId }) => runId);
}

function seedOpenTurn(
  seeds: Record<string, LegacySession>,
  session: SeededSession,
  workspace: string,
  conversation: ConversationState,
  sent: SentRuns,
): void {
  const seed = (seeds[workspace] ??= {
    ...session,
    sessionId: workspace,
    recover: undefined,
    openTurn: { ...session.openTurn, builderState: emptyBuilderState() },
  });
  const state = seed.openTurn!.builderState as BuilderState;
  const { turns, turn_count, turns_started, updated } = conversation;
  state.tracing[session.sessionId] = { turns, turn_count, turns_started, updated };
  for (const runId of sent.runIds) state.posted[runId] = { postedAtMs: sent.atMs, closed: false };
}

export async function readLegacySessions(config: Config): Promise<LegacySession[]> {
  const seeds: Record<string, LegacySession> = {};
  const sessions: LegacySession[] = [];
  for (const [conversationId, conversation] of Object.entries(readState(config.stateFilePath))) {
    const origin = savedOrigin(conversation);
    const workspace = savedWorkspace(conversation) ?? config.cwd;
    const project = origin?.project ?? config.project;
    const session: LegacySession = {
      sessionId: conversationId,
      transcriptPath: transcriptPath(workspace, conversationId),
      updatedAt: Date.parse(conversation.updated),
      writer: writerOptions(config, project),
      recover: () => runEngineWorker(config, conversationId, project),
    };
    const open = Object.values(conversation.turns).sort((a, b) => b.startMs - a.startMs)[0];
    if (open === undefined) {
      sessions.push(session);
      continue;
    }
    const openTurn = { rootRunId: turnRunId(conversationId, open.generation_id) };
    const runIds = await oldRunsSent(config, conversationId, openTurn.rootRunId);
    const sent = { runIds, atMs: open.startMs };
    seedOpenTurn(seeds, { ...session, openTurn }, workspace, conversation, sent);
    sessions.push({ ...session, openTurn });
  }
  return [...sessions, ...Object.values(seeds)];
}
