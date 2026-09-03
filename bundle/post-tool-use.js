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
var LS_INTEGRATION_VERSION = true ? "0.4.0" : process.env.LANGSMITH_CURSOR_INTEGRATION_VERSION || void 0;
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
function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
function isFileConfig(value) {
  if (!isRecord(value))
    return false;
  const optional = (key, type) => value[key] === void 0 || typeof value[key] === type;
  return optional("enabled", "boolean") && optional("api_key", "string") && optional("api_url", "string") && optional("project", "string") && optional("attachments", "boolean") && optional("system_prompt", "boolean") && optional("step_fidelity", "boolean") && optional("cursor_db_path", "string") && optional("redact", "boolean") && (value.metadata === void 0 || isRecord(value.metadata)) && (value.replicas === void 0 || Array.isArray(value.replicas) && value.replicas.every(isRecord));
}
function readConfigFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return isFileConfig(parsed) ? { present: true, value: parsed } : { present: true };
  } catch (error2) {
    return error2.code === "ENOENT" ? { present: false } : { present: true };
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
  const globalResult = readConfigFile(join(homedir2(), ".cursor", "langsmith.json"));
  const localResult = readConfigFile(join(cwd, ".cursor", "langsmith.json"));
  const globalFile = globalResult.value;
  const localFile = localResult.value;
  const traceEnvPresent = Object.hasOwn(process.env, "TRACE_TO_LANGSMITH");
  const envEnabled = parseBoolean(process.env.TRACE_TO_LANGSMITH);
  const envMetadata = parseJson(getEnv("METADATA"));
  const envReplicas = parseJson(getEnv("RUNS_ENDPOINTS"));
  const envDebug = parseBoolean(getEnv("DEBUG"));
  const enabled = traceEnvPresent ? envEnabled ?? false : localResult.present && !localFile ? false : localFile?.enabled ?? globalFile?.enabled ?? false;
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

// dist/utils/hook-init.js
function initHook(cwd) {
  const config = loadConfig({ cwd });
  initLogger(config.debug);
  if (!config.enabled) {
    return null;
  }
  if (!config.apiKey && (!config.replicas || config.replicas.length === 0)) {
    error("Tracing enabled but no API key set (langsmith.json api_key, LANGSMITH_CURSOR_API_KEY, or LANGSMITH_API_KEY) and no replicas configured");
    return null;
  }
  return config;
}

// dist/state.js
import { readFileSync as readFileSync2, writeFileSync, mkdirSync as mkdirSync2, openSync, closeSync, unlinkSync, renameSync as renameSync2, statSync as statSync2 } from "node:fs";
import { dirname as dirname2 } from "node:path";
import { randomUUID } from "node:crypto";
var LOCK_TIMEOUT_MS = 5e3;
var LOCK_RETRY_MS = 20;
var MALFORMED_LOCK_MAX_AGE_MS = LOCK_TIMEOUT_MS * 2;
var CORRUPT_STATE_KEY = "__langsmith_corrupt_state__";
function lockPath(stateFilePath) {
  return `${stateFilePath}.lock`;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function processIsDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error2) {
    return error2.code === "ESRCH";
  }
}
function removeRecoverableLock(lock) {
  try {
    const owner = JSON.parse(readFileSync2(lock, "utf-8"));
    if (typeof owner.pid !== "number" || typeof owner.id !== "string" || typeof owner.createdAt !== "number" || !processIsDead(owner.pid)) {
      return false;
    }
  } catch {
    try {
      if (Date.now() - statSync2(lock).mtimeMs < MALFORMED_LOCK_MAX_AGE_MS)
        return false;
    } catch {
      return false;
    }
  }
  try {
    unlinkSync(lock);
    return true;
  } catch {
    return false;
  }
}
async function acquireLock(stateFilePath) {
  const lock = lockPath(stateFilePath);
  const owner = { pid: process.pid, id: randomUUID(), createdAt: Date.now() };
  const serialized = JSON.stringify(owner);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  mkdirSync2(dirname2(stateFilePath), { recursive: true });
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lock, "wx", 384);
      try {
        writeFileSync(fd, serialized);
      } finally {
        closeSync(fd);
      }
      return serialized;
    } catch (error2) {
      if (error2.code !== "EEXIST")
        throw error2;
      if (removeRecoverableLock(lock))
        continue;
      await sleep(LOCK_RETRY_MS);
    }
  }
  throw new Error("Timed out acquiring LangSmith state lock");
}
function releaseLock(stateFilePath, owner) {
  try {
    if (readFileSync2(lockPath(stateFilePath), "utf-8") === owner)
      unlinkSync(lockPath(stateFilePath));
  } catch {
  }
}
async function atomicUpdateState(stateFilePath, fn) {
  const owner = await acquireLock(stateFilePath);
  try {
    saveState(stateFilePath, fn(loadState(stateFilePath)));
  } finally {
    releaseLock(stateFilePath, owner);
  }
}
function corruptState(policies = {}) {
  return {
    ...policies,
    [CORRUPT_STATE_KEY]: { turns: {}, turn_count: 0, updated: "", tracing: "metadata" }
  };
}
function stickyMetadataPolicies(value) {
  const policies = {};
  for (const [id, entry] of Object.entries(value)) {
    if (id === CORRUPT_STATE_KEY || !record(entry) || entry.tracing !== "metadata")
      continue;
    policies[id] = {
      turns: {},
      turn_count: typeof entry.turn_count === "number" && Number.isInteger(entry.turn_count) ? Math.max(0, entry.turn_count) : 0,
      updated: typeof entry.updated === "string" ? entry.updated : "",
      tracing: "metadata"
    };
  }
  return policies;
}
function record(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
function validUsage(value) {
  if (value === void 0)
    return true;
  if (!record(value))
    return false;
  return Object.values(value).every((entry) => entry === void 0 || typeof entry === "number");
}
function validTool(value) {
  if (!record(value))
    return false;
  return typeof value.tool_use_id === "string" && typeof value.name === "string" && record(value.input) && typeof value.endMs === "number" && (value.failed === void 0 || typeof value.failed === "boolean") && (value.error === void 0 || typeof value.error === "string") && (value.failure_type === void 0 || typeof value.failure_type === "string") && (value.duration === void 0 || typeof value.duration === "number");
}
function validSubagent(value) {
  if (!record(value))
    return false;
  return typeof value.subagent_id === "string" && typeof value.subagent_type === "string" && typeof value.task === "string" && typeof value.startMs === "number" && (value.endMs === void 0 || typeof value.endMs === "number") && (value.tools === void 0 || Array.isArray(value.tools) && value.tools.every(validTool));
}
function validTurn(value) {
  if (!record(value))
    return false;
  return typeof value.generation_id === "string" && (value.tracing_mode === "full" || value.tracing_mode === "metadata") && typeof value.startMs === "number" && (value.endMs === void 0 || typeof value.endMs === "number") && Array.isArray(value.tools) && value.tools.every(validTool) && Array.isArray(value.thoughts) && value.thoughts.every((thought) => record(thought) && typeof thought.text === "string" && (thought.duration_ms === void 0 || typeof thought.duration_ms === "number")) && Array.isArray(value.subagents) && value.subagents.every(validSubagent) && validUsage(value.usage) && (value.prompt === void 0 || typeof value.prompt === "string") && (value.model === void 0 || typeof value.model === "string") && (value.finalText === void 0 || typeof value.finalText === "string") && (value.status === void 0 || typeof value.status === "string");
}
function validConversation(value) {
  if (!record(value) || !record(value.turns))
    return false;
  return Object.values(value.turns).every(validTurn) && typeof value.turn_count === "number" && Number.isInteger(value.turn_count) && value.turn_count >= 0 && typeof value.updated === "string" && (value.tracing === void 0 || value.tracing === "metadata") && (value.parent_conversation_id === void 0 || typeof value.parent_conversation_id === "string") && (value.parent_generation_id === void 0 || typeof value.parent_generation_id === "string");
}
function metadataStatus(status) {
  if (status == null)
    return void 0;
  return status === "completed" ? "completed" : "error";
}
function sanitizeMetadataTurn(turn) {
  turn.tracing_mode = "metadata";
  delete turn.prompt;
  delete turn.finalText;
  turn.status = metadataStatus(turn.status);
  turn.thoughts = [];
  turn.tools = turn.tools.map((tool) => ({
    tool_use_id: "",
    name: tool.name,
    input: {},
    failed: tool.failed ?? tool.error != null,
    duration: tool.duration,
    endMs: tool.endMs
  }));
  turn.subagents = turn.subagents.map((subagent) => ({
    subagent_id: "",
    subagent_type: subagent.subagent_type,
    task: "",
    model: subagent.model,
    is_parallel_worker: subagent.is_parallel_worker,
    status: metadataStatus(subagent.status),
    duration_ms: subagent.duration_ms,
    message_count: subagent.message_count,
    tool_call_count: subagent.tool_call_count,
    loop_count: subagent.loop_count,
    startMs: subagent.startMs,
    endMs: subagent.endMs,
    tools: subagent.tools?.map((tool) => ({
      tool_use_id: "",
      name: tool.name,
      input: {},
      failed: tool.failed ?? tool.error != null,
      duration: tool.duration,
      endMs: tool.endMs
    }))
  }));
  return turn;
}
function enforceConversationTracing(conv) {
  if (conv.tracing === "metadata") {
    for (const turn of Object.values(conv.turns))
      sanitizeMetadataTurn(turn);
  }
  return conv;
}
function loadState(stateFilePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync2(stateFilePath, "utf-8"));
  } catch {
    try {
      readFileSync2(stateFilePath, "utf-8");
      return corruptState();
    } catch {
      return {};
    }
  }
  if (!record(parsed))
    return corruptState();
  const state = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (id === CORRUPT_STATE_KEY || !validConversation(value)) {
      return corruptState(stickyMetadataPolicies(parsed));
    }
    state[id] = enforceConversationTracing(value);
  }
  return state;
}
function saveState(stateFilePath, state) {
  mkdirSync2(dirname2(stateFilePath), { recursive: true });
  const temp = `${stateFilePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 384 });
    renameSync2(temp, stateFilePath);
  } catch (error2) {
    try {
      unlinkSync(temp);
    } catch {
    }
    throw error2;
  }
}
function getConversationState(state, conversationId) {
  return state[conversationId] ?? { turns: {}, turn_count: 0, updated: "" };
}
function newTurnBuffer(generationId, startMs, tracingMode2 = "full") {
  return {
    generation_id: generationId,
    tracing_mode: tracingMode2,
    startMs,
    tools: [],
    thoughts: [],
    subagents: []
  };
}
var CONVERSATION_MAX_AGE_MS = 24 * 60 * 60 * 1e3;

// dist/trace-control.js
function tracingMode(state, conversationId) {
  return state[CORRUPT_STATE_KEY] || getConversationState(state, conversationId).tracing === "metadata" ? "metadata" : "full";
}

// dist/normalize.js
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function preferModel(current, incoming) {
  if (incoming && incoming.toLowerCase() !== "default")
    return incoming;
  return current ?? incoming;
}
function parseToolOutput(raw) {
  if (typeof raw !== "string")
    return raw;
  const trimmed = raw.trim();
  if (trimmed === "")
    return raw;
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}
var MCP_TOOL_PREFIX = "MCP:";
function mcpContentToText(content) {
  if (!Array.isArray(content))
    return void 0;
  const texts = content.filter(isRecord2).map((part) => typeof part.text === "string" ? part.text : void 0).filter((text) => text != null && text !== "");
  return texts.length > 0 ? texts.join("\n") : void 0;
}
function extractMcpError(toolName, output) {
  if (!toolName.startsWith(MCP_TOOL_PREFIX))
    return void 0;
  if (!isRecord2(output) || output.isError !== true)
    return void 0;
  return mcpContentToText(output.content) ?? "MCP tool returned isError: true";
}

// dist/reducer.js
function touch(conv) {
  conv.updated = (/* @__PURE__ */ new Date()).toISOString();
}
function openSubagentParent(state, childConversationId) {
  const candidates = [];
  for (const [conversationId, conv] of Object.entries(state)) {
    if (conversationId === childConversationId)
      continue;
    for (const turn of Object.values(conv.turns)) {
      if (turn.subagents.some((subagent) => subagent.endMs == null)) {
        candidates.push({
          conversationId,
          generationId: turn.generation_id,
          mode: turn.tracing_mode
        });
      }
    }
  }
  if (candidates.length === 1)
    return candidates[0];
  if (candidates.length > 1) {
    return {
      conversationId: "__unresolved_subagent__",
      generationId: "__unresolved_subagent__",
      mode: "metadata"
    };
  }
  return void 0;
}
function conversationForEvent(state, conversationId) {
  const conv = enforceConversationTracing(getConversationState(state, conversationId));
  if (conv.tracing === "metadata" || conv.parent_conversation_id)
    return conv;
  const parent = openSubagentParent(state, conversationId);
  if (parent) {
    conv.tracing = "metadata";
    enforceConversationTracing(conv);
  }
  return conv;
}
function eventTracingMode(state, conversationId, conv) {
  if (conv.tracing === "metadata")
    return "metadata";
  if (conv.parent_conversation_id && conv.parent_generation_id) {
    return state[conv.parent_conversation_id]?.turns[conv.parent_generation_id]?.tracing_mode ?? "metadata";
  }
  return tracingMode(state, conversationId);
}
function reducePostToolUse(state, input, nowMs) {
  const conv = conversationForEvent(state, input.conversation_id);
  const turn = conv.turns[input.generation_id] ?? newTurnBuffer(input.generation_id, nowMs, eventTracingMode(state, input.conversation_id, conv));
  turn.model = preferModel(turn.model, input.model);
  const output = turn.tracing_mode === "full" ? parseToolOutput(input.tool_output) : void 0;
  turn.tools.push({
    tool_use_id: turn.tracing_mode === "full" ? input.tool_use_id : "",
    name: input.tool_name,
    input: turn.tracing_mode === "full" ? input.tool_input ?? {} : {},
    output,
    error: turn.tracing_mode === "full" ? extractMcpError(input.tool_name, output) : void 0,
    duration: input.duration,
    endMs: nowMs
  });
  conv.turns[input.generation_id] = turn;
  touch(conv);
  return { ...state, [input.conversation_id]: conv };
}

// dist/hooks/post-tool-use.js
async function main() {
  const input = await readStdin();
  const config = initHook(input.workspace_roots?.[0]);
  if (!config)
    return;
  debug(`postToolUse ${input.tool_name} conv=${input.conversation_id} gen=${input.generation_id}`);
  await atomicUpdateState(config.stateFilePath, (s) => reducePostToolUse(s, input, Date.now()));
}
main().catch((err) => {
  try {
    error(`postToolUse hook error: ${err}`);
  } catch {
  }
  process.exit(1);
});
