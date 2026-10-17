#!/usr/bin/env node

// dist/src/hooks/guard.js
import { execFileSync, spawnSync as spawnSync2 } from "node:child_process";
import { userInfo } from "node:os";

// dist/src/constants.js
var MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
var MAX_LOG_BYTES = 5 * 1024 * 1024;
var CONVERSATION_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
var HOOK_CONTINUE_OUTPUT = `${JSON.stringify({ continue: true })}
`;

// dist/src/logger.js
import { appendFileSync, mkdirSync, statSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
var LOG_FILE = process.env.LANGSMITH_CURSOR_LOG_FILE ?? `${homedir()}/.cursor/langsmith-hook.log`;
function rotateIfNeeded() {
  try {
    if (statSync(LOG_FILE).size >= MAX_LOG_BYTES) {
      renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
  } catch {
  }
}
function write(level, message) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace("T", " ").replace("Z", "");
  const line = `${timestamp} [${level}] ${message}
`;
  try {
    rotateIfNeeded();
    appendFileSync(LOG_FILE, line);
  } catch {
  }
}
function error(message) {
  write("ERROR", message);
}

// dist/src/utils/node-version.js
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

// dist/src/utils/node-path-cache.js
import { spawnSync } from "node:child_process";
import { mkdirSync as mkdirSync2, readFileSync, renameSync as renameSync2, unlinkSync, writeFileSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname2, join } from "node:path";
var NODE_PATH_CACHE_TTL_MS = 24 * 60 * 60 * 1e3;
var NODE_PATH_VALIDATION_TIMEOUT_MS = 1e4;
function nodePathCacheFile() {
  return join(homedir2(), ".cursor", "langsmith-node.json");
}
function readCachedNodePath(cacheFile = nodePathCacheFile(), now = Date.now()) {
  try {
    const cache = JSON.parse(readFileSync(cacheFile, "utf8"));
    const expireAt = typeof cache.expire_at === "string" ? Date.parse(cache.expire_at) : NaN;
    if (cache.node_path !== null && (typeof cache.node_path !== "string" || !cache.node_path) || !Number.isFinite(expireAt) || expireAt <= now || expireAt > now + NODE_PATH_CACHE_TTL_MS) {
      return void 0;
    }
    return cache.node_path;
  } catch {
    return void 0;
  }
}
function isNodePathValid(nodePath, spawn = spawnSync) {
  try {
    const result = spawn(nodePath, ["--version"], { timeout: NODE_PATH_VALIDATION_TIMEOUT_MS });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}
function writeCachedNodePath(nodePath, cacheFile = nodePathCacheFile(), now = Date.now()) {
  const temporaryFile = `${cacheFile}.${process.pid}.${now}.tmp`;
  try {
    mkdirSync2(dirname2(cacheFile), { recursive: true });
    const cache = {
      node_path: nodePath,
      expire_at: new Date(now + NODE_PATH_CACHE_TTL_MS).toISOString()
    };
    writeFileSync(temporaryFile, JSON.stringify(cache) + "\n", { mode: 384 });
    renameSync2(temporaryFile, cacheFile);
  } catch {
    try {
      unlinkSync(temporaryFile);
    } catch {
    }
  }
}

// dist/src/hooks/guard.js
var hookName = process.argv[2];
function resolveLoginShellNode() {
  const cachedNode = readCachedNodePath();
  if (cachedNode === null)
    return void 0;
  if (cachedNode && isNodePathValid(cachedNode))
    return cachedNode;
  try {
    const loginShell = userInfo().shell || process.env.SHELL || "/bin/sh";
    const shellName = loginShell.split("/").pop();
    const marker = "__LANGSMITH_SHELL_NODE_EXECUTABLE__";
    const probe = `node -e 'process.stdout.write("${marker}" + process.execPath + "\\n")'`;
    const shellArgs = shellName === "fish" ? ["--login", "--interactive", "--command", probe] : shellName === "bash" || shellName === "zsh" || shellName === "ksh" ? ["-l", "-i", "-c", probe] : ["-l", "-c", probe];
    const output = execFileSync(loginShell, shellArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1e4
    });
    const markedLine = output.split(/\r?\n/).find((line) => line.includes(marker));
    const executable = markedLine?.slice(markedLine.indexOf(marker) + marker.length).trim();
    if (executable)
      writeCachedNodePath(executable);
    return executable || void 0;
  } catch {
    writeCachedNodePath(null);
    return void 0;
  }
}
if (!process.env.LANGSMITH_CURSOR_NODE_HANDOFF && nodeTooOld(process.versions.node)) {
  const loginShellNode = resolveLoginShellNode();
  if (loginShellNode && loginShellNode !== process.execPath) {
    try {
      const result = spawnSync2(loginShellNode, process.argv.slice(1), {
        env: { ...process.env, LANGSMITH_CURSOR_NODE_HANDOFF: "1" },
        stdio: "inherit"
      });
      if (result.error)
        throw result.error;
      process.exit(result.status ?? 0);
    } catch {
    }
  }
}
if (nodeTooOld(process.versions.node)) {
  const msg = `[langsmith] Node ${process.versions.node} at ${process.execPath} is too old for tracing (need >= ${MIN_NODE[0]}.${MIN_NODE[1]} for node:sqlite). This turn was NOT traced. The Node configured by your login shell could not be used; install Node >= ${MIN_NODE[0]}.${MIN_NODE[1]} or check your shell startup files. See README troubleshooting.`;
  error(msg);
  console.error(msg);
  if (hookName === "before-submit-prompt")
    process.stdout.write(HOOK_CONTINUE_OUTPUT);
  process.exit(0);
}
if (!hookName) {
  console.error("[langsmith] guard: missing hook name argument");
  process.exit(0);
}
await import(new URL("./hooks.js", import.meta.url).href).catch((err) => {
  console.error(`[langsmith] hook ${hookName} failed:`, err);
  if (hookName === "before-submit-prompt")
    process.stdout.write(HOOK_CONTINUE_OUTPUT);
  process.exit(0);
});
