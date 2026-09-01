/**
 * Single-executable entry point.
 *
 * Cursor invokes the same binary for every event and passes the hook name as
 * argv[2]. The explicit import table lets esbuild include every hook in the
 * one CommonJS file embedded in the SEA.
 */

import { spawn } from "node:child_process";
import { LS_INTEGRATION_VERSION } from "./version.js";

const hooks: Record<string, () => Promise<unknown>> = {
  "before-submit-prompt": () => import("./hooks/before-submit-prompt.js"),
  "after-agent-response": () => import("./hooks/after-agent-response.js"),
  "post-tool-use": () => import("./hooks/post-tool-use.js"),
  "post-tool-use-failure": () => import("./hooks/post-tool-use-failure.js"),
  "subagent-start": () => import("./hooks/subagent-start.js"),
  "subagent-stop": () => import("./hooks/subagent-stop.js"),
  stop: async () => {
    const { completion } = await import("./hooks/stop.js");
    await completion;
  },
  "session-start": () => import("./hooks/session-start.js"),
};

const hookName = process.argv[2];
const runHook = hookName && Object.hasOwn(hooks, hookName) ? hooks[hookName] : undefined;

async function runAutomaticUpdate(): Promise<void> {
  const { debug, log, warn } = await import("./logger.js");
  try {
    const { updateFromGitHub } = await import("./updater.js");
    const update = await updateFromGitHub();
    debug(`Automatic update result: ${update.status}`);
    if (update.status === "updated") {
      log(`Updated LangSmith tracing binary to ${update.version}`);
    }
  } catch (err) {
    warn(`Automatic update failed: ${err}`);
  }
}

function spawnAutomaticUpdate(): void {
  try {
    const child = spawn(process.execPath, ["--background-update"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", (err) => {
      console.error(`[langsmith] could not start automatic update: ${err}`);
    });
    child.unref();
  } catch (err) {
    console.error(`[langsmith] could not start automatic update: ${err}`);
  }
}

if (hookName === "--version") {
  console.log(LS_INTEGRATION_VERSION ?? "development");
} else if (hookName === "--background-update") {
  void runAutomaticUpdate();
} else if (!runHook) {
  const supported = Object.keys(hooks).join(", ");
  console.error(
    hookName
      ? `[langsmith] unknown hook "${hookName}" (expected one of: ${supported})`
      : `[langsmith] missing hook name (expected one of: ${supported})`,
  );
} else {
  void (async () => {
    try {
      await runHook();
    } catch (err) {
      console.error(`[langsmith] hook ${hookName} failed:`, err);
      process.exitCode = 1;
    } finally {
      if (hookName === "stop") {
        spawnAutomaticUpdate();
      }
    }
  })();
}
