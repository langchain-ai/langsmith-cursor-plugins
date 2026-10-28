import { binary } from "../binary-target.js";
import { LS_INTEGRATION_VERSION } from "../config.js";
import { BINARY_HOOK_EVENTS, ENGINE_WORKER_COMMAND, HOOK_CONTINUE_OUTPUT } from "../constants.js";
import { error } from "../logger.js";
import type { HookCommandOptions, HookRunner } from "@langchain/plugins-base/plugin";

const EXECUTABLE_NAME = binary.target.executableName;

const USAGE = `Usage:
  ${EXECUTABLE_NAME} <hook-name>
  ${EXECUTABLE_NAME} --version

Hook names: ${Object.values(BINARY_HOOK_EVENTS).join(", ")}`;

const HOOK_RUNNERS: Record<string, HookRunner> = {
  [BINARY_HOOK_EVENTS.beforeSubmitPrompt]: () => import("./before-submit-prompt.js").then((hook) => hook.run()),
  [BINARY_HOOK_EVENTS.afterAgentResponse]: () => import("./after-agent-response.js").then((hook) => hook.run()),
  [BINARY_HOOK_EVENTS.afterAgentThought]: () => import("./after-agent-thought.js").then((hook) => hook.run()),
  [BINARY_HOOK_EVENTS.subagentStart]: () => import("./subagent-start.js").then((hook) => hook.run()),
  [BINARY_HOOK_EVENTS.subagentStop]: () => import("./subagent-stop.js").then((hook) => hook.run()),
  [BINARY_HOOK_EVENTS.stop]: () => import("./stop.js").then((hook) => hook.run()),
  [BINARY_HOOK_EVENTS.postToolUse]: () => import("./post-tool-use.js").then((hook) => hook.run()),
  [BINARY_HOOK_EVENTS.postToolUseFailure]: () => import("./post-tool-use-failure.js").then((hook) => hook.run()),
  [BINARY_HOOK_EVENTS.sessionStart]: () => import("./session-start.js").then((hook) => hook.run()),
};

export const HOOK_COMMAND_OPTIONS: HookCommandOptions = {
  usage: USAGE,
  version: LS_INTEGRATION_VERSION ?? "development",
  hooks: HOOK_RUNNERS,
  worker: {
    command: ENGINE_WORKER_COMMAND,
    run: (args) => import("./engine-worker.js").then((hook) => hook.run(args)),
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
