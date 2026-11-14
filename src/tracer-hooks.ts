import { statSync } from "node:fs";
import { dirname } from "node:path";
import { launchDetachedWorker } from "@langchain/plugins-base/plugin";
import type { HookRunner } from "@langchain/plugins-base/plugin";
import { sendHookNote, startTracerWorker, tracerPaths } from "@langchain/plugins-base/tracer";
import type { TracingMode } from "@langchain/plugins-base/tracer";
import { loadConfig, PLUGIN_VERSION } from "./config.js";
import {
  BINARY_HOOK_EVENTS,
  ENGINE_WORKER_COMMAND,
  LS_INTEGRATION,
  OFF_NOTES_WORKER_BYTES,
} from "./constants.js";
import { warn } from "./logger.js";
import { handlePromptSubmit } from "./prompt-control.js";
import { createTranscriptBuilder } from "./tracer-builder.js";
import { originFromConfig } from "./turn-origin.js";
import { initHook } from "./utils/hook-init.js";
import { readStdin } from "./utils/stdin.js";
import { writerOptions } from "./writer-options.js";
import type { Config } from "./models/config.js";
import type { BuilderSettings, CursorHookInput, NoteDetails } from "./models/tracer-builder.js";
import type { BeforeSubmitPromptInput, StopInput, TurnStarter } from "./models/types.js";

function builderSettings(config: Config): BuilderSettings {
  return {
    attachmentsEnabled: config.attachmentsEnabled,
    systemPromptEnabled: config.systemPromptEnabled,
    cursorDbPath: config.cursorDbPath,
    captureHookOutputs: config.captureHookOutputs,
    defaultMuted: config.defaultMuted,
    locked: config.locked,
    sweepIdleMinutes: config.sweepIdleMinutes,
    stateFilePath: config.stateFilePath,
    cwd: config.cwd,
  };
}

export async function sendCursorNote(
  input: CursorHookInput,
  config: Config,
  tracingMode?: TracingMode,
): Promise<void> {
  const paths = tracerPaths(dirname(config.stateFilePath));
  const details: NoteDetails = {
    input,
    time: Date.now(),
    origin: originFromConfig(config, input),
    settings: builderSettings(config),
  };
  let launch: Promise<unknown> | undefined;
  sendHookNote(
    {
      integration: LS_INTEGRATION,
      event: input.hook_event_name,
      sessionId: config.cwd,
      ...(tracingMode === undefined ? {} : { tracingMode }),
      details,
      writer: writerOptions(config, config.project),
    },
    {
      paths,
      version: PLUGIN_VERSION,
      startWorker: () => {
        const notesSize = statSync(paths.notes, { throwIfNoEntry: false })?.size ?? 0;
        if (tracingMode === "off" && notesSize < OFF_NOTES_WORKER_BYTES) return;
        launch = launchDetachedWorker([ENGINE_WORKER_COMMAND, config.cwd], {
          storageRoot: paths.folder,
        }).catch((err: unknown) => warn(`Could not start the tracing worker: ${err}`));
      },
    },
  );
  await launch;
}

const sendPromptNote: TurnStarter = (input, config, mode) =>
  sendCursorNote(mode === "off" ? { ...input, prompt: "" } : input, config, mode);

async function answerPrompt(): Promise<void> {
  const input = await readStdin<BeforeSubmitPromptInput>();
  process.stdout.write(JSON.stringify(await handlePromptSubmit(input, sendPromptNote)) + "\n");
}

async function sendNote(): Promise<void> {
  const input = await readStdin<CursorHookInput>();
  const config = initHook(input.workspace_roots?.[0]);
  if (config) await sendCursorNote(input, config);
}

async function sendStopNote(): Promise<void> {
  const input = await readStdin<StopInput>();
  const config = initHook(input.workspace_roots?.[0]);
  if (config) await sendCursorNote(input, config);
  else await sendCursorNote(input, loadConfig({ cwd: input.workspace_roots?.[0] }), "off");
}

export const NOTE_RUNNERS: Record<string, HookRunner> = {
  ...Object.fromEntries(Object.values(BINARY_HOOK_EVENTS).map((name) => [name, sendNote])),
  [BINARY_HOOK_EVENTS.beforeSubmitPrompt]: answerPrompt,
  [BINARY_HOOK_EVENTS.stop]: sendStopNote,
};

export async function runTracerWorker(cwd: string | undefined): Promise<void> {
  const config = initHook(cwd);
  if (!config) return;
  await startTracerWorker({
    agentStateFolder: dirname(config.stateFilePath),
    integration: LS_INTEGRATION,
    version: PLUGIN_VERSION,
    writer: writerOptions(config, config.project),
    createBuilder: createTranscriptBuilder,
    readLegacySessions: () => [],
  });
}
