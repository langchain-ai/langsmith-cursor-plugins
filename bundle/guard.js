#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// dist/src/constants.js
var COMPILED_BINARY_ROOT, BINARY_INSTALL_DIRECTORY_NAME, CURSOR_DIRECTORY_NAME, CURSOR_HOOKS_FILE_NAME;
var init_constants = __esm({
  "dist/src/constants.js"() {
    "use strict";
    COMPILED_BINARY_ROOT = "/$bunfs/";
    BINARY_INSTALL_DIRECTORY_NAME = ".langsmith";
    CURSOR_DIRECTORY_NAME = ".cursor";
    CURSOR_HOOKS_FILE_NAME = "hooks.json";
  }
});

// dist/src/utils/binary-runtime.js
function runningCompiledBinary() {
  const main = globalThis.Bun?.main;
  return typeof main === "string" && main.startsWith(COMPILED_BINARY_ROOT);
}
var init_binary_runtime = __esm({
  "dist/src/utils/binary-runtime.js"() {
    "use strict";
    init_constants();
  }
});

// dist/src/utils/command.js
function commandExecutable(command) {
  const match = LEADING_EXECUTABLE.exec(command.trim());
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}
var LEADING_EXECUTABLE;
var init_command = __esm({
  "dist/src/utils/command.js"() {
    "use strict";
    LEADING_EXECUTABLE = /^"([^"]*)"|^'([^']*)'|^(\S+)/;
  }
});

// dist/src/utils/hooks-file.js
import * as fs from "node:fs/promises";
import { basename, dirname as dirname2, join as join2 } from "node:path";
function cursorHooksPath(root) {
  return join2(root, CURSOR_DIRECTORY_NAME, CURSOR_HOOKS_FILE_NAME);
}
function registeredCommands(file) {
  const manifest = file.hooks;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    return [];
  return Object.values(manifest).flatMap((hooks) => Array.isArray(hooks) ? hooks : []).map((hook) => hook?.command).filter((command) => typeof command === "string");
}
async function readHooksFile(path) {
  return fs.readFile(path, "utf-8").then((text) => JSON.parse(text), () => ({}));
}
var init_hooks_file = __esm({
  "dist/src/utils/hooks-file.js"() {
    "use strict";
    init_constants();
  }
});

// dist/binary.config.json
var binary_config_default;
var init_binary_config = __esm({
  "dist/binary.config.json"() {
    binary_config_default = {
      executableName: "langsmith-cursor-tracing",
      repository: "langchain-ai/langsmith-cursor-plugins",
      installer: {
        productName: "Cursor",
        shortUrl: "https://langch.in/cursor-tracing",
        environmentPrefix: "LANGSMITH_CURSOR",
        output: "install.sh",
        helpFooter: [
          "Only macOS arm64 and x64 are published, and the matching one is picked for you.",
          "Leave the langsmith-tracing plugin enabled; it stops tracing while this binary is",
          "registered. Fully restart Cursor when this finishes so it reloads its hooks."
        ],
        unsupportedPlatformHelp: [
          "The plugin does the same tracing and works on Windows and Linux.",
          "In Cursor, open Settings, then Plugins, then add it by repository URL:",
          "",
          "  https://github.com/langchain-ai/langsmith-cursor-plugins",
          "",
          "Fully restart Cursor once it is installed."
        ]
      },
      build: {
        entryPoint: "src/hooks/dispatch.ts",
        outputDirectory: "bin",
        versionFile: ".cursor-plugin/plugin.json",
        minify: false,
        defines: {
          __LS_BINARY_HOOKS__: "hooks/hooks.binary.json"
        }
      },
      sign: {
        entitlements: "macos-entitlements.plist"
      }
    };
  }
});

// dist/src/installed-binary.js
import { homedir as homedir2 } from "node:os";
import { join as join3 } from "node:path";
function installedBinaryPath() {
  return join3(homedir2(), BINARY_INSTALL_DIRECTORY_NAME, binary_config_default.executableName);
}
var init_installed_binary = __esm({
  "dist/src/installed-binary.js"() {
    "use strict";
    init_binary_config();
    init_constants();
  }
});

// dist/src/stand-down.js
var stand_down_exports = {};
__export(stand_down_exports, {
  pluginShouldStandDown: () => pluginShouldStandDown
});
import { constants } from "node:fs";
import * as fs2 from "node:fs/promises";
import { homedir as homedir3 } from "node:os";
async function binaryCanRun(executable) {
  return fs2.access(executable, constants.X_OK).then(() => true, () => false);
}
async function hooksFileRunsBinary(hooksFile, executable) {
  const commands = registeredCommands(await readHooksFile(hooksFile));
  return commands.some((command) => commandExecutable(command) === executable);
}
async function pluginShouldStandDown() {
  try {
    if (runningCompiledBinary())
      return false;
    const installed = installedBinaryPath();
    if (!await binaryCanRun(installed))
      return false;
    for (const root of [process.cwd(), homedir3()]) {
      if (await hooksFileRunsBinary(cursorHooksPath(root), installed))
        return true;
    }
    return false;
  } catch {
    return false;
  }
}
var init_stand_down = __esm({
  "dist/src/stand-down.js"() {
    "use strict";
    init_binary_runtime();
    init_command();
    init_hooks_file();
    init_installed_binary();
  }
});

// dist/src/hooks/guard.js
import { execFileSync, spawnSync as spawnSync2 } from "node:child_process";
import { appendFileSync } from "node:fs";
import { userInfo, homedir as homedir4 } from "node:os";

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

// dist/src/hooks/guard.js
var hookName = process.argv[2];
var { pluginShouldStandDown: pluginShouldStandDown2 } = await Promise.resolve().then(() => (init_stand_down(), stand_down_exports));
if (await pluginShouldStandDown2())
  process.exit(0);
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
  const logFile = process.env.LANGSMITH_CURSOR_LOG_FILE ?? `${homedir4()}/.cursor/langsmith-hook.log`;
  try {
    appendFileSync(logFile, msg + "\n");
  } catch {
  }
  console.error(msg);
  if (hookName === "before-submit-prompt") {
    console.log(JSON.stringify({ continue: false, user_message: msg }));
  }
  process.exit(0);
}
if (!hookName) {
  console.error("[langsmith] guard: missing hook name argument");
  process.exit(0);
}
await import(new URL(`./${hookName}.js`, import.meta.url).href).catch((err) => {
  console.error(`[langsmith] hook ${hookName} failed:`, err);
  if (hookName === "before-submit-prompt") {
    console.log(JSON.stringify({
      continue: false,
      user_message: "Tracing prompt hook could not load. Submission blocked; repair installation."
    }));
  }
  process.exit(0);
});
