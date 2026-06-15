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
var MAX_LOG_BYTES = 5 * 1024 * 1024;
var LOG_FILE = process.env.CURSOR_LANGSMITH_LOG_FILE ?? `${process.env.HOME ?? ""}/.cursor/langsmith-hook.log`;
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
function readConfigFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return void 0;
  }
}
function getEnv(suffix) {
  return process.env[`CURSOR_LANGSMITH_${suffix}`] ?? process.env[`LANGSMITH_${suffix}`];
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
function loadConfig(options) {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const cwd = options?.cwd ?? process.cwd();
  const globalFile = readConfigFile(join(home, ".cursor", "langsmith.json"));
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
  const cursorDbPath = getEnv("DB_PATH") ?? localFile?.cursor_db_path ?? globalFile?.cursor_db_path;
  const stateFilePath = process.env.CURSOR_LANGSMITH_STATE_FILE ?? join(home, ".cursor", "langsmith-state.json");
  const identityMetadata = { local_username: userInfo().username };
  const repo = getRepoName(cwd);
  if (repo) {
    identityMetadata.repository_name = repo.name;
    identityMetadata.repository_provider = repo.provider;
  }
  const fileMetadata = { ...globalFile?.metadata, ...localFile?.metadata };
  const customMetadata = { ...identityMetadata, ...fileMetadata, ...envMetadata };
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
    cursorDbPath
  };
}

// dist/utils/hook-init.js
function initHook(cwd) {
  const config = loadConfig({ cwd });
  initLogger(config.debug);
  if (!config.enabled) {
    return null;
  }
  if (!config.apiKey && (!config.replicas || config.replicas.length === 0)) {
    error("Tracing enabled but no API key set (langsmith.json api_key, CURSOR_LANGSMITH_API_KEY, or LANGSMITH_API_KEY) and no replicas configured");
    return null;
  }
  return config;
}

// dist/state.js
import { readFileSync as readFileSync2, writeFileSync, mkdirSync as mkdirSync2, openSync, closeSync, unlinkSync } from "node:fs";
import { dirname as dirname2 } from "node:path";
var LOCK_TIMEOUT_MS = 5e3;
var LOCK_RETRY_MS = 20;
function lockPath(stateFilePath) {
  return `${stateFilePath}.lock`;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function acquireLock(stateFilePath) {
  const lock = lockPath(stateFilePath);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  mkdirSync2(dirname2(stateFilePath), { recursive: true });
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lock, "wx");
      closeSync(fd);
      return;
    } catch {
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    unlinkSync(lock);
  } catch {
  }
}
function releaseLock(stateFilePath) {
  try {
    unlinkSync(lockPath(stateFilePath));
  } catch {
  }
}
async function atomicUpdateState(stateFilePath, fn) {
  await acquireLock(stateFilePath);
  try {
    const state = loadState(stateFilePath);
    writeFileSync(stateFilePath, JSON.stringify(fn(state), null, 2));
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

// dist/reducer.js
function touch(conv) {
  conv.updated = (/* @__PURE__ */ new Date()).toISOString();
}
function latestTurnId(turns) {
  let best;
  let bestMs = -1;
  for (const [id, t] of Object.entries(turns)) {
    if (t.startMs > bestMs) {
      bestMs = t.startMs;
      best = id;
    }
  }
  return best;
}
function reduceSubagentStart(state, input, nowMs) {
  const parentConv = input.parent_conversation_id ?? input.conversation_id;
  const conv = getConversationState(state, parentConv);
  const turnId = latestTurnId(conv.turns);
  const turn = turnId ? conv.turns[turnId] : newTurnBuffer(input.generation_id, nowMs);
  turn.subagents.push({
    subagent_id: input.subagent_id,
    subagent_type: input.subagent_type,
    task: input.task,
    startMs: nowMs
  });
  conv.turns[turn.generation_id] = turn;
  touch(conv);
  return { ...state, [parentConv]: conv };
}

// dist/hooks/subagent-start.js
async function main() {
  const input = await readStdin();
  const config = initHook(input.workspace_roots?.[0]);
  if (!config)
    return;
  debug(`subagentStart ${input.subagent_type} (${input.subagent_id})`);
  await atomicUpdateState(config.stateFilePath, (s) => reduceSubagentStart(s, input, Date.now()));
}
main().catch((err) => {
  try {
    error(`subagentStart hook error: ${err}`);
  } catch {
  }
  process.exit(0);
});
