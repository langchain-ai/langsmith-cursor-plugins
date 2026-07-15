#!/usr/bin/env node

// dist/hooks/guard.js
import { appendFileSync } from "node:fs";

// dist/utils/node-version.js
var MIN_NODE = [22, 13];
function nodeTooOld(version, min = MIN_NODE) {
  const parts = version.split(".");
  const major = Number.parseInt(parts[0] ?? "", 10);
  const minor = Number.parseInt(parts[1] ?? "", 10);
  if (!Number.isFinite(major))
    return false;
  if (major !== min[0])
    return major < min[0];
  return (Number.isFinite(minor) ? minor : 0) < min[1];
}

// dist/hooks/guard.js
var hookName = process.argv[2];
if (nodeTooOld(process.versions.node)) {
  const msg = `[langsmith] Node ${process.versions.node} at ${process.execPath} is too old for tracing (need >= ${MIN_NODE[0]}.${MIN_NODE[1]} for node:sqlite). This turn was NOT traced. Cursor runs this node, not your shell's \u2014 install Node >= ${MIN_NODE[0]}.${MIN_NODE[1]} on the system PATH, or launch Cursor from a terminal. See README troubleshooting.`;
  const logFile = process.env.LANGSMITH_CURSOR_LOG_FILE ?? `${process.env.HOME ?? ""}/.cursor/langsmith-hook.log`;
  try {
    appendFileSync(logFile, msg + "\n");
  } catch {
  }
  console.error(msg);
  process.exit(0);
}
if (!hookName) {
  console.error("[langsmith] guard: missing hook name argument");
  process.exit(0);
}
await import(new URL(`./${hookName}.js`, import.meta.url).href).catch((err) => {
  console.error(`[langsmith] hook ${hookName} failed:`, err);
  process.exit(0);
});
