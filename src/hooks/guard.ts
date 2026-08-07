#!/usr/bin/env node
/**
 * Version guard for the bundled hooks.
 *
 * Cursor launches hooks from a GUI context, where the `node` on PATH is often
 * NOT the developer's version-managed node (nvm/mise/asdf): it can be an old
 * system/Homebrew node, or missing entirely. The real hooks import
 * `node:sqlite`, which needs Node >= 22.13; on older node that import throws
 * ERR_UNKNOWN_BUILTIN_MODULE at module-load — *before* any of our code runs —
 * so the failure is silent (no log line, no trace, turn_count stuck at 0).
 *
 * This guard imports nothing that touches node:sqlite. It first hands execution
 * to the Node selected by the user's login shell, then checks that Node's
 * version and dynamically imports the real hook — deferring the sqlite load
 * until the check has passed. (A dynamic import runs after this module's own
 * code; a static import would be hoisted and crash before the check.)
 *
 * Invoked as: node ./bundle/guard.js <hook-name>
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { userInfo } from "node:os";
import { MIN_NODE, nodeTooOld } from "../utils/node-version.js";
import {
  isNodePathValid,
  readCachedNodePath,
  writeCachedNodePath,
} from "../utils/node-path-cache.js";

const hookName = process.argv[2];

/**
 * Resolve the Node binary selected by the current user's login shell. Cursor
 * is commonly launched without the PATH changes made by nvm, mise, or asdf,
 * so the Node which starts this guard may not be the Node used in a terminal.
 */
function resolveLoginShellNode(): string | undefined {
  try {
  const cachedNode = readCachedNodePath();
  if (cachedNode && isNodePathValid(cachedNode)) return cachedNode;

    const loginShell = userInfo().shell || process.env.SHELL || "/bin/sh";
    const shellName = loginShell.split("/").pop();
    const marker = "__LANGSMITH_SHELL_NODE_EXECUTABLE__";
    const probe = `node -e 'process.stdout.write("${marker}" + process.execPath + "\\n")'`;
    const shellArgs =
      shellName === "fish"
        ? ["--login", "--interactive", "--command", probe]
        : shellName === "bash" || shellName === "zsh" || shellName === "ksh"
          ? ["-l", "-i", "-c", probe]
          : ["-l", "-c", probe];

    // Shell startup files sometimes print messages. Only accept text following
    // our marker, and suppress startup stderr so it cannot pollute hook output.
    const output = execFileSync(loginShell, shellArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    const markedLine = output.split(/\r?\n/).find((line) => line.includes(marker));
    const executable = markedLine?.slice(markedLine.indexOf(marker) + marker.length).trim();
    if (executable) writeCachedNodePath(executable);
    return executable || undefined;
  } catch {
    // Best effort: if login-shell resolution fails, continue with the Node
    // which Cursor used to launch this guard and let the version check explain.
    return undefined;
  }
}

// Re-run this guard under the login shell's Node. The environment marker makes
// the handoff one-shot even if the two executable paths differ only by symlink.
if (!process.env.LANGSMITH_CURSOR_NODE_HANDOFF) {
  const loginShellNode = resolveLoginShellNode();
  if (loginShellNode && loginShellNode !== process.execPath) {
    try {
      const result = spawnSync(loginShellNode, process.argv.slice(1), {
        env: { ...process.env, LANGSMITH_CURSOR_NODE_HANDOFF: "1" },
        stdio: "inherit",
      });
      if (result.error) throw result.error;
      process.exit(result.status ?? 0);
    } catch {
      // Best effort: a stale or non-executable result should not prevent the
      // current Node from reaching the version check below.
    }
  }
}

if (nodeTooOld(process.versions.node)) {
  const msg =
    `[langsmith] Node ${process.versions.node} at ${process.execPath} is too old for tracing ` +
    `(need >= ${MIN_NODE[0]}.${MIN_NODE[1]} for node:sqlite). This turn was NOT traced. ` +
    `The Node configured by your login shell could not be used; install Node >= ` +
    `${MIN_NODE[0]}.${MIN_NODE[1]} or check your shell startup files. See README troubleshooting.`;
  const logFile =
    process.env.LANGSMITH_CURSOR_LOG_FILE ?? `${process.env.HOME ?? ""}/.cursor/langsmith-hook.log`;
  try {
    appendFileSync(logFile, msg + "\n");
  } catch {
    // best effort — logging must not itself throw
  }
  console.error(msg);
  // Exit 0: a non-zero exit would make Cursor surface a hook failure every turn.
  process.exit(0);
}

if (!hookName) {
  console.error("[langsmith] guard: missing hook name argument");
  process.exit(0);
}

// Defer loading the real (sqlite-importing) hook until the version check passes.
// Resolve relative to this file so it works regardless of cwd.
await import(new URL(`./${hookName}.js`, import.meta.url).href).catch((err: unknown) => {
  console.error(`[langsmith] hook ${hookName} failed:`, err);
  process.exit(0);
});
