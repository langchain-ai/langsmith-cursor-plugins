import { binary } from "../binary-target.js";
import { PLUGIN_VERSION } from "../config.js";
import { BINARY_HOOK_EVENTS, ENGINE_WORKER_COMMAND, HOOK_CONTINUE_OUTPUT } from "../constants.js";
import { error } from "../logger.js";
import type { HookCommandOptions } from "@langchain/plugins-base/plugin";
import { NOTE_RUNNERS, runTracerWorker } from "../tracer-hooks.js";

const EXECUTABLE_NAME = binary.target.executableName;

const USAGE = `Usage:
  ${EXECUTABLE_NAME} <hook-name>
  ${EXECUTABLE_NAME} --version

Hook names: ${Object.values(BINARY_HOOK_EVENTS).join(", ")}`;

export const HOOK_COMMAND_OPTIONS: HookCommandOptions = {
  usage: USAGE,
  version: PLUGIN_VERSION,
  hooks: NOTE_RUNNERS,
  worker: {
    command: ENGINE_WORKER_COMMAND,
    run: ([cwd]) => runTracerWorker(cwd),
  },
  onHookError: (name, err) => {
    error(`${name} hook error: ${err}`);
    if (name !== BINARY_HOOK_EVENTS.beforeSubmitPrompt) return;
    console.error(`[langsmith] prompt hook failed: ${err}. This turn is not traced.`);
    process.stdout.write(HOOK_CONTINUE_OUTPUT);
  },
  onUnknown: (argument) => {
    console.error(argument ? `unknown argument: ${argument}` : "missing hook name");
    console.error(USAGE);
    process.exitCode = 1;
  },
};
