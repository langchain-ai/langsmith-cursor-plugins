import { installBinary } from "../binary-install.js";
import { binary } from "../binary-target.js";
import { describeUpdate, updateInstalledBinary } from "../binary-update.js";
import { LS_INTEGRATION_VERSION } from "../config.js";
import { BINARY_HOOK_EVENTS } from "../constants.js";
import { pluginShouldStandDown } from "../stand-down.js";
import type { BinaryHookName, LoadedHook } from "../types.js";
import { drainStdinToAvoidEpipe } from "../utils/stdin.js";

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
  ${EXECUTABLE_NAME} --install [--print] [--project] [--tag VERSION]
  ${EXECUTABLE_NAME} --update
  ${EXECUTABLE_NAME} --version

Hook names: ${Object.values(BINARY_HOOK_EVENTS).join(", ")}`;

function isHookName(argument: string | undefined): argument is BinaryHookName {
  return argument !== undefined && Object.hasOwn(HOOK_MODULES, argument);
}

async function runHook(name: BinaryHookName): Promise<void> {
  try {
    if (await pluginShouldStandDown()) {
      await drainStdinToAvoidEpipe();
      return;
    }
    const loaded = await HOOK_MODULES[name]();
    await loaded.finished;
  } catch (err) {
    console.error(`[langsmith] hook ${name} failed: ${String(err)}`);
    process.exitCode = 1;
  }
}

async function runInstall(args: string[]): Promise<void> {
  try {
    console.log(await installBinary(args));
  } catch (err) {
    console.error(`[langsmith] install failed: ${String(err)}`);
    process.exitCode = 1;
  }
}

async function runUpdate(): Promise<void> {
  try {
    console.log(describeUpdate(await updateInstalledBinary()));
  } catch (err) {
    console.error(`[langsmith] update failed: ${String(err)}`);
    process.exitCode = 1;
  }
}

const args = process.argv.slice(2);
const argument = args[0];

if (argument === "--help" || argument === "-h") {
  console.log(USAGE);
} else if (argument === "--version" || argument === "-v") {
  console.log(LS_INTEGRATION_VERSION ?? "development");
} else if (argument === "--install") {
  void runInstall(args.slice(1));
} else if (argument === "--update") {
  void runUpdate();
} else if (isHookName(argument)) {
  void runHook(argument);
} else {
  console.error(argument ? `unknown argument: ${argument}` : "missing hook name");
  console.error(USAGE);
  process.exitCode = 1;
}
