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
var LOG_FILE = process.env.LANGSMITH_CURSOR_LOG_FILE ?? `${process.env.HOME ?? ""}/.cursor/langsmith-hook.log`;
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
var LS_INTEGRATION_VERSION = true ? "0.2.0" : process.env.LANGSMITH_CURSOR_INTEGRATION_VERSION || void 0;
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
  const systemPromptEnabled = parseBoolean(getEnv("SYSTEM_PROMPT")) ?? localFile?.system_prompt ?? globalFile?.system_prompt ?? true;
  const cursorDbPath = getEnv("DB_PATH") ?? localFile?.cursor_db_path ?? globalFile?.cursor_db_path;
  const redact = parseBoolean(getEnv("REDACT")) ?? localFile?.redact ?? globalFile?.redact ?? true;
  const redactExtraRules = parseRedactExtraRules(getEnv("REDACT_EXTRA"));
  const stateFilePath = process.env.LANGSMITH_CURSOR_STATE_FILE ?? join(home, ".cursor", "langsmith-state.json");
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
var CONVERSATION_MAX_AGE_MS = 24 * 60 * 60 * 1e3;

// dist/normalize.js
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var SUBAGENT_PSEUDO_TOOLS = /* @__PURE__ */ new Set(["UpdateCurrentStep"]);
function parseSubagentTranscript(rows) {
  const toolCalls = [];
  let resultText;
  for (const row of rows) {
    if (!isRecord(row) || row.role !== "assistant")
      continue;
    const message = isRecord(row.message) ? row.message : void 0;
    const content = message?.content;
    if (!Array.isArray(content))
      continue;
    for (const part of content) {
      if (!isRecord(part))
        continue;
      if (part.type === "tool_use" && typeof part.name === "string") {
        if (SUBAGENT_PSEUDO_TOOLS.has(part.name))
          continue;
        toolCalls.push({ name: part.name, input: isRecord(part.input) ? part.input : {} });
      } else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        resultText = part.text;
      }
    }
  }
  return { toolCalls, resultText };
}

// dist/reducer.js
function touch(conv) {
  conv.updated = (/* @__PURE__ */ new Date()).toISOString();
}
function collectTools(conv) {
  const tools = [];
  for (const turn of Object.values(conv.turns))
    tools.push(...turn.tools);
  return tools.sort((a, b) => a.endMs - b.endMs);
}
function findChildConversation(state, parentConv, startMs, nowMs) {
  const slack = 2e3;
  let best;
  let bestScore = 0;
  for (const [convId, conv] of Object.entries(state)) {
    if (convId === parentConv || conv.turn_count !== 0)
      continue;
    const inWindow = collectTools(conv).filter((t) => t.endMs >= startMs - slack && t.endMs <= nowMs + slack).length;
    if (inWindow > bestScore) {
      bestScore = inWindow;
      best = convId;
    }
  }
  return best;
}
function transcriptToolEvent(call, index, count, startMs, endMs) {
  const span = Math.max(0, endMs - startMs);
  const slice = count > 0 ? span / count : 0;
  const end = Math.round(startMs + slice * (index + 1));
  return {
    tool_use_id: `subagent-tool-${index}`,
    name: call.name,
    input: call.input,
    duration: slice / 1e3,
    endMs: end
  };
}
function reduceSubagentStop(state, input, nowMs, resolved) {
  const parentConv = input.parent_conversation_id ?? input.conversation_id;
  const conv = getConversationState(state, parentConv);
  let target;
  for (const turn of Object.values(conv.turns)) {
    const sub = turn.subagents.find((s) => s.subagent_id === input.subagent_id && s.endMs == null);
    if (sub) {
      target = sub;
      break;
    }
  }
  if (!target) {
    touch(conv);
    return { ...state, [parentConv]: conv };
  }
  target.status = input.status;
  target.duration_ms = input.duration_ms;
  target.description = input.description;
  target.message_count = input.message_count;
  target.tool_call_count = input.tool_call_count;
  target.loop_count = input.loop_count;
  target.endMs = nowMs;
  if (resolved?.resultText)
    target.resultText = resolved.resultText;
  let next = { ...state, [parentConv]: conv };
  const childConv = resolved?.childConversationId ?? findChildConversation(next, parentConv, target.startMs, nowMs);
  if (childConv && next[childConv]) {
    target.childConversationId = childConv;
    target.tools = collectTools(next[childConv]);
    const { [childConv]: _consumed, ...rest } = next;
    next = rest;
  } else if (resolved?.toolCalls?.length) {
    const calls = resolved.toolCalls;
    target.childConversationId = resolved.childConversationId;
    target.tools = calls.map((c, i) => transcriptToolEvent(c, i, calls.length, target.startMs, nowMs));
  }
  touch(conv);
  return next;
}

// dist/subagent-transcript.js
import { readFileSync as readFileSync3, readdirSync, statSync as statSync2 } from "node:fs";
import { dirname as dirname3, join as join2, basename } from "node:path";
function normalizeWs(text) {
  return text.replace(/\s+/g, " ").trim();
}
function readJsonl(path) {
  const rows = [];
  for (const line of readFileSync3(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed)
      continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
    }
  }
  return rows;
}
function firstUserText(rows) {
  for (const row of rows) {
    if (!isRecord(row) || row.role !== "user")
      continue;
    const content = isRecord(row.message) ? row.message.content : void 0;
    if (!Array.isArray(content))
      continue;
    return content.filter((p) => isRecord(p) && p.type === "text").map((p) => typeof p.text === "string" ? p.text : "").join("");
  }
  return "";
}
function resolveSubagentTranscript(parentTranscriptPath, task) {
  if (!parentTranscriptPath)
    return void 0;
  try {
    const dir = join2(dirname3(parentTranscriptPath), "subagents");
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0)
      return void 0;
    const candidates = files.map((f) => {
      const full = join2(dir, f);
      return { full, child: basename(f, ".jsonl"), mtime: statSync2(full).mtimeMs };
    });
    const wanted = task ? normalizeWs(task).slice(0, 120) : "";
    let chosen;
    if (candidates.length === 1) {
      chosen = candidates[0];
    } else {
      const matches = candidates.map((c) => ({ ...c, rows: readJsonl(c.full) })).filter((c) => wanted !== "" && normalizeWs(firstUserText(c.rows)).includes(wanted));
      const pool = matches.length > 0 ? matches : candidates;
      chosen = pool.slice().sort((a, b) => b.mtime - a.mtime)[0];
    }
    const rows = chosen.rows ?? readJsonl(chosen.full);
    const { toolCalls, resultText } = parseSubagentTranscript(rows);
    return { childConversationId: chosen.child, toolCalls, resultText };
  } catch {
    return void 0;
  }
}

// dist/hooks/subagent-stop.js
async function main() {
  const input = await readStdin();
  const config = initHook(input.workspace_roots?.[0]);
  if (!config)
    return;
  debug(`subagentStop ${input.subagent_type} (${input.subagent_id})`);
  const resolved = resolveSubagentTranscript(input.transcript_path, input.task);
  if (resolved) {
    debug(`resolved subagent transcript: child=${resolved.childConversationId}, ${resolved.toolCalls.length} tool call(s)`);
  }
  await atomicUpdateState(config.stateFilePath, (s) => reduceSubagentStop(s, input, Date.now(), resolved));
}
main().catch((err) => {
  try {
    error(`subagentStop hook error: ${err}`);
  } catch {
  }
  process.exit(1);
});
