#!/usr/bin/env node

// dist/utils/stdin.js
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error(`Failed to parse hook input: ${err}`));
      }
    });
    process.stdin.on("error", reject);
  });
}

// dist/config.js
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

// dist/logger.js
import { appendFileSync, mkdirSync, statSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
var MAX_LOG_BYTES = 5 * 1024 * 1024;
var LOG_FILE = process.env.LANGSMITH_CURSOR_LOG_FILE ?? `${homedir()}/.cursor/langsmith-hook.log`;
var debugEnabled = false;
function initLogger(debug2) {
  debugEnabled = debug2;
  mkdirSync(dirname(LOG_FILE), { recursive: true });
}
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
function warn(message) {
  write("WARN", message);
}
function error(message) {
  write("ERROR", message);
}
function debug(message) {
  if (debugEnabled) {
    write("DEBUG", message);
  }
}

// dist/constants.js
var DEFAULT_PROJECT = "cursor";

// dist/config.js
import { homedir as homedir2 } from "node:os";
var LS_INTEGRATION_VERSION = true ? "0.3.5" : process.env.LANGSMITH_CURSOR_INTEGRATION_VERSION || void 0;
var PROVIDER_HOSTS = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
  devAzure: "dev.azure.com"
};
var DEFAULT_API_URL = "https://api.smith.langchain.com";
function parseBoolean(value) {
  if (typeof value === "boolean")
    return value;
  if (typeof value !== "string")
    return void 0;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v))
    return true;
  if (["0", "false", "no", "off"].includes(v))
    return false;
  return void 0;
}
function parseJson(value) {
  if (typeof value !== "string" || value.trim().length === 0)
    return void 0;
  try {
    return JSON.parse(value);
  } catch {
    return void 0;
  }
}
function isRedactRule(rule) {
  if (typeof rule !== "object" || rule === null)
    return false;
  const r = rule;
  return typeof r.pattern === "string" && (r.replace === void 0 || typeof r.replace === "string");
}
function parseRedactExtraRules(value) {
  const parsed = parseJson(value);
  if (parsed === void 0)
    return void 0;
  if (!Array.isArray(parsed)) {
    error("LANGSMITH_CURSOR_REDACT_EXTRA must be a JSON array of { pattern, replace }.");
    return void 0;
  }
  const valid = [];
  for (const rule of parsed) {
    if (!isRedactRule(rule)) {
      error(`Skipping invalid LANGSMITH_CURSOR_REDACT_EXTRA rule: ${JSON.stringify(rule)}`);
      continue;
    }
    valid.push(rule);
  }
  return valid.length > 0 ? valid : void 0;
}
function readConfigFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return void 0;
  }
}
function getEnv(suffix) {
  return process.env[`LANGSMITH_CURSOR_${suffix}`] ?? process.env[`LANGSMITH_${suffix}`];
}
function normalizeReplicas(replicas) {
  if (!Array.isArray(replicas))
    return void 0;
  return replicas.map((r) => ({
    ...r.api_url || r.apiUrl ? { apiUrl: r.api_url ?? r.apiUrl } : {},
    ...r.api_key || r.apiKey ? { apiKey: r.api_key ?? r.apiKey } : {},
    ...r.project || r.projectName ? { projectName: r.project ?? r.projectName } : {},
    ...r.updates ? { updates: r.updates } : {}
  }));
}
var GIT_PROVIDERS_REGEX = {
  github: /[@/](?:github\.com)[:/](.+?)(?:\.git)?\s/,
  gitlab: /[@/](?:gitlab\.com)[:/](.+?)(?:\.git)?\s/,
  bitbucket: /[@/](?:bitbucket\.org)[:/](.+?)(?:\.git)?\s/,
  devAzure: /[@/](?:dev\.azure\.com)[:/](.+?)(?:\.git)?\s/
};
function parseRepoName(remoteUrl) {
  for (const [provider, regex] of Object.entries(GIT_PROVIDERS_REGEX)) {
    const match = remoteUrl.match(regex);
    if (match)
      return { provider, name: match[1] };
  }
  return void 0;
}
function getRepoName(cwd) {
  try {
    const output = execSync("git remote -v", {
      cwd,
      encoding: "utf-8",
      timeout: 5e3,
      stdio: ["ignore", "pipe", "ignore"]
    });
    const remotes = [];
    for (const line of output.trim().split("\n").filter(Boolean)) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2 && line.includes("(fetch)")) {
        remotes.push({ name: parts[0], url: parts[1] });
      }
    }
    const origin = remotes.find((r) => r.name === "origin");
    if (origin) {
      const name = parseRepoName(origin.url + " ");
      if (name)
        return name;
    }
    for (const remote of remotes) {
      const name = parseRepoName(remote.url + " ");
      if (name)
        return name;
    }
  } catch {
  }
  return void 0;
}
function getGitInfo(cwd) {
  const result = {};
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf-8",
      timeout: 5e3,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (branch && branch !== "HEAD")
      result.branch = branch;
  } catch {
  }
  try {
    const commit = execSync("git rev-parse HEAD", {
      cwd,
      encoding: "utf-8",
      timeout: 5e3,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (commit)
      result.commit = commit;
  } catch {
  }
  return result;
}
function loadConfig(options) {
  const cwd = options?.cwd ?? process.env.CURSOR_PROJECT_DIR ?? process.cwd();
  const globalFile = readConfigFile(join(homedir2(), ".cursor", "langsmith.json"));
  const localFile = readConfigFile(join(cwd, ".cursor", "langsmith.json"));
  const envEnabled = parseBoolean(process.env.TRACE_TO_LANGSMITH);
  const envMetadata = parseJson(getEnv("METADATA"));
  const envReplicas = parseJson(getEnv("RUNS_ENDPOINTS"));
  const envDebug = parseBoolean(getEnv("DEBUG"));
  const enabled = envEnabled ?? localFile?.enabled ?? globalFile?.enabled ?? false;
  const apiKey = getEnv("API_KEY") ?? localFile?.api_key ?? globalFile?.api_key ?? "";
  const apiUrl = getEnv("ENDPOINT") ?? localFile?.api_url ?? globalFile?.api_url ?? DEFAULT_API_URL;
  const project = getEnv("PROJECT") ?? localFile?.project ?? globalFile?.project ?? DEFAULT_PROJECT;
  const debug2 = envDebug ?? false;
  const replicas = normalizeReplicas(envReplicas ?? localFile?.replicas ?? globalFile?.replicas);
  const attachmentsEnabled = parseBoolean(getEnv("ATTACHMENTS")) ?? localFile?.attachments ?? globalFile?.attachments ?? true;
  const systemPromptEnabled = parseBoolean(getEnv("SYSTEM_PROMPT")) ?? localFile?.system_prompt ?? globalFile?.system_prompt ?? true;
  const cursorDbPath = getEnv("DB_PATH") ?? localFile?.cursor_db_path ?? globalFile?.cursor_db_path;
  const redact = parseBoolean(getEnv("REDACT")) ?? localFile?.redact ?? globalFile?.redact ?? true;
  const redactExtraRules = parseRedactExtraRules(getEnv("REDACT_EXTRA"));
  const stateFilePath = process.env.LANGSMITH_CURSOR_STATE_FILE ?? join(homedir2(), ".cursor", "langsmith-state.json");
  const baseMetadata = { cwd };
  if (LS_INTEGRATION_VERSION)
    baseMetadata.ls_integration_version = LS_INTEGRATION_VERSION;
  const repo = getRepoName(cwd);
  if (repo) {
    baseMetadata.repository_name = repo.name;
    baseMetadata.repository_provider = repo.provider;
    const host = PROVIDER_HOSTS[repo.provider];
    if (host)
      baseMetadata.repository_url = `https://${host}/${repo.name}`;
  }
  const git = getGitInfo(cwd);
  if (git.branch)
    baseMetadata.git_branch = git.branch;
  if (git.commit)
    baseMetadata.git_commit_sha = git.commit;
  baseMetadata.local_username = userInfo().username;
  const fileMetadata = { ...globalFile?.metadata, ...localFile?.metadata };
  const customMetadata = { ...baseMetadata, ...fileMetadata, ...envMetadata };
  if (enabled && !apiKey && (!replicas || replicas.length === 0)) {
    debug("Config enabled but no API key / replicas resolved");
  }
  return {
    enabled,
    apiKey,
    apiUrl,
    project,
    debug: debug2,
    stateFilePath,
    replicas,
    customMetadata,
    attachmentsEnabled,
    systemPromptEnabled,
    cursorDbPath,
    redact,
    redactExtraRules
  };
}

// dist/state.js
import { readFileSync as readFileSync2, writeFileSync, mkdirSync as mkdirSync2, openSync, closeSync, unlinkSync, rmdirSync, renameSync as renameSync2, fsyncSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { dirname as dirname2 } from "node:path";
var LOCK_TIMEOUT_MS = 2e3;
function lockPath(stateFilePath) {
  return `${stateFilePath}.lock`;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function acquireLock(stateFilePath) {
  const lock = lockPath(stateFilePath);
  const deadline = performance.now() + LOCK_TIMEOUT_MS;
  mkdirSync2(dirname2(stateFilePath), { recursive: true, mode: 448 });
  while (true) {
    try {
      mkdirSync2(lock, { mode: 448 });
      return;
    } catch (error2) {
      if (error2.code !== "EEXIST")
        throw error2;
      if (performance.now() >= deadline)
        throw new Error("Timed out waiting for turn-state lock; confirm no writer is running before removing it");
      await sleep(10 + Math.random() * 20);
    }
  }
}
function releaseLock(stateFilePath) {
  try {
    rmdirSync(lockPath(stateFilePath));
  } catch {
    warn("Turn-state lock cleanup failed; confirm no writer is running before removing it");
  }
}
async function atomicUpdateState(stateFilePath, fn) {
  await acquireLock(stateFilePath);
  try {
    const state = loadState(stateFilePath);
    saveState(stateFilePath, fn(state));
  } finally {
    releaseLock(stateFilePath);
  }
}
function loadState(stateFilePath) {
  try {
    return JSON.parse(readFileSync2(stateFilePath, "utf-8"));
  } catch {
    return {};
  }
}
function saveState(stateFilePath, state) {
  mkdirSync2(dirname2(stateFilePath), { recursive: true, mode: 448 });
  const temp = `${stateFilePath}.${process.pid}.${randomUUID()}.tmp`;
  let committed = false;
  try {
    const fd = openSync(temp, "wx", 384);
    try {
      writeFileSync(fd, JSON.stringify(state, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync2(temp, stateFilePath);
    committed = true;
    try {
      const fd2 = openSync(dirname2(stateFilePath), "r");
      try {
        fsyncSync(fd2);
      } finally {
        closeSync(fd2);
      }
    } catch {
      warn("Turn snapshot saved, but crash durability could not be confirmed");
    }
  } finally {
    if (!committed) {
      try {
        unlinkSync(temp);
      } catch {
      }
    }
  }
}
function getConversationState(state, conversationId) {
  return state[conversationId] ?? { turns: {}, turn_count: 0, updated: "" };
}
function newTurnBuffer(generationId, startMs) {
  return {
    generation_id: generationId,
    startMs,
    tools: [],
    thoughts: [],
    subagents: []
  };
}
var CONVERSATION_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
function pruneOldConversations(state, now = Date.now()) {
  const cutoff = now - CONVERSATION_MAX_AGE_MS;
  const pruned = {};
  for (const [conversationId, conv] of Object.entries(state)) {
    const updatedMs = conv.updated ? new Date(conv.updated).getTime() : 0;
    if (updatedMs >= cutoff) {
      pruned[conversationId] = conv;
    }
  }
  return pruned;
}

// dist/reducer.js
function touch(conv) {
  conv.updated = (/* @__PURE__ */ new Date()).toISOString();
}
function reduceBeforeSubmitPrompt(state, input, nowMs, mode = "full") {
  const conv = getConversationState(state, input.conversation_id);
  if (conv.completedOffGenerations?.includes(input.generation_id))
    return state;
  if (conv.turns[input.generation_id])
    return state;
  const turn = newTurnBuffer(input.generation_id, nowMs);
  turn.tracingMode = mode;
  turn.prompt = mode === "off" ? void 0 : input.prompt;
  turn.model = input.model;
  conv.turns[input.generation_id] = turn;
  touch(conv);
  return pruneOldConversations({ ...state, [input.conversation_id]: conv });
}

// dist/tracing-policy.js
import { randomUUID as randomUUID2 } from "node:crypto";
import { lstatSync, readFileSync as readFileSync3 } from "node:fs";
import { mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { dirname as dirname3 } from "node:path";
import { performance as performance2 } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { homedir as homedir3 } from "node:os";
import { join as join2 } from "node:path";
function isMode(value) {
  return value === "full" || value === "metadata";
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasCode(error2, code) {
  return isObject(error2) && error2.code === code;
}
function readPolicy(path) {
  let raw;
  try {
    if (!lstatSync(path).isFile())
      throw new Error("Tracing preferences must be a regular, non-symlink file");
    raw = readFileSync3(path, "utf8");
  } catch (error2) {
    if (hasCode(error2, "ENOENT")) {
      try {
        lstatSync(path);
      } catch (statError) {
        if (hasCode(statError, "ENOENT"))
          return { threads: {} };
        throw statError;
      }
    }
    throw error2;
  }
  const value = JSON.parse(raw);
  if (!isObject(value) || !isObject(value.threads) || Object.values(value.threads).some((mode) => !isMode(mode)) || Object.keys(value).some((key) => key !== "threads")) {
    throw new Error("Invalid tracing preference format");
  }
  return value;
}
function tracingPolicyPath() {
  return process.env.LANGSMITH_CURSOR_PRIVACY_FILE ?? join2(homedir3(), ".cursor", "langsmith-state.privacy.json");
}
function getThreadTracingMode(path, sessionId) {
  try {
    const policy = readPolicy(path);
    if (Object.hasOwn(policy.threads, sessionId))
      return policy.threads[sessionId];
    return "full";
  } catch {
    return "metadata";
  }
}
function parseTracingCommand(prompt) {
  if (prompt === "langsmith-tracing:mute")
    return "mute";
  if (prompt === "langsmith-tracing:unmute")
    return "unmute";
  return void 0;
}
async function setThreadTracingMode(path, sessionId, mode) {
  if (typeof sessionId !== "string" || !sessionId || !isMode(mode)) {
    throw new Error("A nonempty session ID and a full/metadata tracing mode are required");
  }
  const lockPath2 = `${path}.lock`;
  await mkdir(dirname3(path), { recursive: true, mode: 448 });
  const deadline = performance2.now() + 2e3;
  let locked = false;
  while (!locked) {
    try {
      await mkdir(lockPath2, { mode: 448 });
      locked = true;
    } catch (error2) {
      if (!hasCode(error2, "EEXIST"))
        throw error2;
      if (performance2.now() >= deadline) {
        throw new Error(`Timed out waiting for tracing preference lock ${lockPath2}. Retry; if it persists, remove the lock only after confirming no preference writer is running.`);
      }
      await delay(10 + Math.random() * 20);
    }
  }
  const warnings = [];
  async function bestEffort(action, message) {
    try {
      await action();
    } catch (error2) {
      warnings.push(`${message}: ${error2 instanceof Error ? error2.message : String(error2)}`);
    }
  }
  let tempPath;
  try {
    let policy;
    try {
      policy = readPolicy(path);
    } catch (error2) {
      throw new Error(`Cannot read tracing preferences at ${path}. Refusing to overwrite them; repair the file or its permissions before retrying. No preferences were changed.`, { cause: error2 });
    }
    policy.threads = { ...policy.threads, [sessionId]: mode };
    tempPath = `${path}.${process.pid}.${randomUUID2()}.tmp`;
    const temp = await open(tempPath, "wx", 384);
    try {
      await temp.writeFile(`${JSON.stringify(policy)}
`, "utf8");
      await temp.sync();
    } catch (error2) {
      await bestEffort(() => temp.close(), "Temporary file close failed");
      throw error2;
    }
    await temp.close();
    await rename(tempPath, path);
    tempPath = void 0;
    await bestEffort(async () => {
      const directory = await open(dirname3(path), "r");
      try {
        await directory.sync();
      } finally {
        await bestEffort(() => directory.close(), "Directory close cleanup failed");
      }
    }, "Preference is effective, but crash durability could not be confirmed; retry saving");
  } finally {
    if (tempPath) {
      await bestEffort(() => unlink(tempPath), "Temporary file cleanup failed");
    }
    await bestEffort(() => rmdir(lockPath2), `Preference lock cleanup failed at ${lockPath2}. Before retrying, remove the lock only after confirming no preference writer is running`);
  }
  return warnings.length ? { warning: warnings.join("; ") } : {};
}

// dist/prompt-control.js
async function handlePromptSubmit(input) {
  const command = parseTracingCommand(input.prompt);
  try {
    if (!input.conversation_id || typeof input.conversation_id !== "string" || !input.generation_id || typeof input.generation_id !== "string") {
      throw new Error("Nonempty native conversation_id and generation_id required; update Cursor");
    }
    const config = loadConfig({ cwd: input.workspace_roots?.[0] });
    initLogger(config.debug);
    if (command) {
      const result = await setThreadTracingMode(tracingPolicyPath(), input.conversation_id, command === "mute" ? "metadata" : "full");
      return {
        continue: false,
        user_message: `Thread tracing ${command === "mute" ? "muted (metadata-only)" : "unmuted (full content)"}. Preference saved for the next turn; the current turn is unchanged.` + (!config.enabled ? " Master tracing is disabled; this does not enable it." : "") + (result.warning ? ` Warning: ${result.warning}` : "")
      };
    }
    const enabled = config.enabled && !!(config.apiKey || config.replicas?.length);
    await atomicUpdateState(config.stateFilePath, (s) => reduceBeforeSubmitPrompt(s, input, Date.now(), enabled ? getThreadTracingMode(tracingPolicyPath(), input.conversation_id) : "off"));
    return { continue: true };
  } catch (error2) {
    return {
      continue: false,
      user_message: `Could not save tracing preference/turn snapshot: ${error2 instanceof Error ? error2.message : String(error2)}. Submission blocked; repair local state/permissions and retry.`
    };
  }
}

// dist/hooks/before-submit-prompt.js
async function main() {
  const input = await readStdin();
  process.stdout.write(JSON.stringify(await handlePromptSubmit(input)) + "\n");
}
main().catch(() => {
  process.stdout.write(JSON.stringify({
    continue: false,
    user_message: "Tracing prompt hook failed. Submission blocked; repair hooks and retry."
  }) + "\n");
});
