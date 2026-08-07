#!/usr/bin/env node

// dist/hooks/guard.js
import { execFileSync, spawnSync as spawnSync2 } from "node:child_process";
import { appendFileSync } from "node:fs";
import { userInfo, homedir as homedir2 } from "node:os";

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

// dist/utils/node-path-cache.js
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
var NODE_PATH_CACHE_TTL_MS = 24 * 60 * 60 * 1e3;
var NODE_PATH_VALIDATION_TIMEOUT_MS = 1e4;
function nodePathCacheFile() {
  return join(homedir(), ".cursor", "langsmith-node.json");
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
    mkdirSync(dirname(cacheFile), { recursive: true });
    const cache = {
      node_path: nodePath,
      expire_at: new Date(now + NODE_PATH_CACHE_TTL_MS).toISOString()
    };
    writeFileSync(temporaryFile, JSON.stringify(cache) + "\n", { mode: 384 });
    renameSync(temporaryFile, cacheFile);
  } catch {
    try {
      unlinkSync(temporaryFile);
    } catch {
    }
  }
}

// dist/hooks/guard.js
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
  const logFile = process.env.LANGSMITH_CURSOR_LOG_FILE ?? `${homedir2()}/.cursor/langsmith-hook.log`;
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
