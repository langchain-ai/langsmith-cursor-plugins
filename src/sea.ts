/**
 * Single-executable entry point.
 *
 * Cursor invokes the same binary for every event and passes the hook name as
 * argv[2]. The explicit import table lets esbuild include every hook in the
 * one CommonJS file embedded in the SEA.
 */

import { LS_INTEGRATION_VERSION } from "./version.js";

const hooks: Record<string, () => Promise<unknown>> = {
  "before-submit-prompt": () => import("./hooks/before-submit-prompt.js"),
  "after-agent-response": () => import("./hooks/after-agent-response.js"),
  "post-tool-use": () => import("./hooks/post-tool-use.js"),
  "post-tool-use-failure": () => import("./hooks/post-tool-use-failure.js"),
  "subagent-start": () => import("./hooks/subagent-start.js"),
  "subagent-stop": () => import("./hooks/subagent-stop.js"),
  stop: () => import("./hooks/stop.js"),
  "session-start": () => import("./hooks/session-start.js"),
};

const hookName = process.argv[2];
const runHook = hookName ? hooks[hookName] : undefined;

if (hookName === "--version") {
  console.log(LS_INTEGRATION_VERSION ?? "development");
} else if (!runHook) {
  const supported = Object.keys(hooks).join(", ");
  console.error(
    hookName
      ? `[langsmith] unknown hook "${hookName}" (expected one of: ${supported})`
      : `[langsmith] missing hook name (expected one of: ${supported})`,
  );
} else {
  void runHook().catch((err: unknown) => {
    console.error(`[langsmith] hook ${hookName} failed:`, err);
    process.exitCode = 1;
  });
}
