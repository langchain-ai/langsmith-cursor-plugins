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
 * This guard imports nothing that touches node:sqlite. It checks the running
 * Node version first, writes a clear message if it's too old, and only then
 * dynamically imports the real hook — deferring the sqlite load until the
 * check has passed. (A dynamic import runs after this module's own code; a
 * static import would be hoisted and crash before the check.)
 *
 * Invoked as: node ./bundle/guard.js <hook-name>
 */
import { appendFileSync } from "node:fs";
import { MIN_NODE, nodeTooOld } from "../utils/node-version.js";

const hookName = process.argv[2];

if (nodeTooOld(process.versions.node)) {
  const msg =
    `[langsmith] Node ${process.versions.node} at ${process.execPath} is too old for tracing ` +
    `(need >= ${MIN_NODE[0]}.${MIN_NODE[1]} for node:sqlite). This turn was NOT traced. ` +
    `Cursor runs this node, not your shell's — install Node >= ${MIN_NODE[0]}.${MIN_NODE[1]} on the ` +
    `system PATH, or launch Cursor from a terminal. See README troubleshooting.`;
  const logFile =
    process.env.LANGSMITH_CURSOR_LOG_FILE ??
    `${process.env.HOME ?? ""}/.cursor/langsmith-hook.log`;
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
await import(new URL(`./${hookName}.js`, import.meta.url).href).catch(
  (err: unknown) => {
    console.error(`[langsmith] hook ${hookName} failed:`, err);
    process.exit(0);
  },
);
