import { binary } from "../binary-target.js";
import { LS_INTEGRATION_VERSION } from "../config.js";
import { BINARY_HOOK_EVENTS } from "../constants.js";
import type { BinaryHookName, LoadedHook } from "../types.js";

const HOOK_MODULES: Record<BinaryHookName, () => Promise<LoadedHook>> = {
  "before-submit-prompt": () => import("./before-submit-prompt.js"),
  "after-agent-response": () => import("./after-agent-response.js"),
  "post-tool-use": () => import("./post-tool-use.js"),
  "post-tool-use-failure": () => import("./post-tool-use-failure.js"),
  "subagent-start": () => import("./subagent-start.js"),
  "subagent-stop": () => import("./subagent-stop.js"),
  stop: () => import("./stop.js"),
  "session-start": () => import("./session-start.js"),
};

const EXECUTABLE_NAME = binary.target.executableName;

const USAGE = `Usage:
  ${EXECUTABLE_NAME} <hook-name>
  ${EXECUTABLE_NAME} --version

Hook names: ${Object.values(BINARY_HOOK_EVENTS).join(", ")}`;

function isHookName(argument: string | undefined): argument is BinaryHookName {
  return argument !== undefined && Object.hasOwn(HOOK_MODULES, argument);
}

async function runHook(name: BinaryHookName): Promise<void> {
  try {
    const loaded = await HOOK_MODULES[name]();
    await loaded.finished;
  } catch (err) {
    console.error(`[langsmith] hook ${name} failed: ${String(err)}`);
  }
}

const argument = process.argv[2];

if (argument === "--help" || argument === "-h") {
  console.log(USAGE);
} else if (argument === "--version" || argument === "-v") {
  console.log(LS_INTEGRATION_VERSION ?? "development");
} else if (isHookName(argument)) {
  void runHook(argument);
} else {
  console.error(argument ? `unknown argument: ${argument}` : "missing hook name");
  console.error(USAGE);
  process.exitCode = 1;
}
