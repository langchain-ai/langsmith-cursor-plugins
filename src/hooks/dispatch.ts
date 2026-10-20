import { dispatchHookCommand } from "@langchain/plugins-base/plugin";
import { binary } from "../binary-target.js";
import { LS_INTEGRATION_VERSION } from "../config.js";
import { BINARY_HOOK_EVENTS } from "../constants.js";
import type { BinaryHookName, LoadedHook } from "../models/types.js";

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

await dispatchHookCommand(process.argv.slice(2), {
  usage: USAGE,
  version: LS_INTEGRATION_VERSION ?? "development",
  hooks: Object.fromEntries(
    Object.entries(HOOK_MODULES).map(([name, load]) => [name, async () => (await load()).finished]),
  ),
  onHookError: (name, err) => console.error(`[langsmith] hook ${name} failed: ${String(err)}`),
  onUnknown: (argument) => {
    console.error(argument ? `unknown argument: ${argument}` : "missing hook name");
    console.error(USAGE);
    process.exitCode = 1;
  },
});
