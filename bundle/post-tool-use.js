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

// dist/shared-config.js
import { lstatSync, readFileSync, statSync } from "node:fs";
var COMMON_BOOLEAN_SETTINGS = {
  enabled: { default: false, restrictive: false },
  defaultMuted: { default: false, restrictive: true }
};
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invalid(raw) {
  return {
    status: "invalid",
    common: { enabled: false, defaultMuted: true },
    ...raw === void 0 ? {} : { raw },
    diagnostics: [
      "Invalid or unreadable common config; ordinary fields discarded, privacy switches restricted."
    ]
  };
}
function parseReplica(value) {
  if (!object(value))
    return void 0;
  const replica = {};
  for (const [canonical, alias] of [
    ["api_url", "apiUrl"],
    ["api_key", "apiKey"],
    ["project", "projectName"]
  ]) {
    const selected = Object.hasOwn(value, canonical) ? canonical : alias;
    if (Object.hasOwn(value, selected)) {
      const entry = value[selected];
      if (typeof entry !== "string")
        return void 0;
      replica[canonical] = entry;
    }
  }
  if (Object.hasOwn(value, "updates")) {
    if (!object(value.updates))
      return void 0;
    replica.updates = value.updates;
  }
  return replica;
}
function parseCommonConfig(value) {
  if (!object(value))
    return invalid();
  const common = {};
  const diagnostics = [];
  for (const field of ["enabled", "defaultMuted"]) {
    if (!Object.hasOwn(value, field))
      continue;
    const entry = value[field];
    common[field] = typeof entry === "boolean" ? entry : COMMON_BOOLEAN_SETTINGS[field].restrictive;
    if (typeof entry !== "boolean")
      diagnostics.push(`Invalid ${field}; using restrictive value.`);
  }
  for (const field of ["api_key", "api_url", "project"]) {
    if (!Object.hasOwn(value, field))
      continue;
    if (typeof value[field] !== "string")
      return invalid(value);
    common[field] = value[field];
  }
  if (Object.hasOwn(value, "redact")) {
    if (typeof value.redact !== "boolean")
      return invalid(value);
    common.redact = value.redact;
  }
  if (Object.hasOwn(value, "metadata")) {
    if (!object(value.metadata))
      return invalid(value);
    common.metadata = value.metadata;
  }
  if (Object.hasOwn(value, "replicas")) {
    if (!Array.isArray(value.replicas))
      return invalid(value);
    const replicas = [];
    for (const entry of value.replicas) {
      const replica = parseReplica(entry);
      if (replica === void 0)
        return invalid(value);
      replicas.push(replica);
    }
    common.replicas = replicas;
  }
  if (Object.hasOwn(value, "redact_extra_rules")) {
    if (!Array.isArray(value.redact_extra_rules))
      return invalid(value);
    const rules = [];
    for (const rule of value.redact_extra_rules) {
      if (!object(rule) || typeof rule.pattern !== "string" || !Object.hasOwn(rule, "pattern")) {
        return invalid(value);
      }
      const hasReplace = Object.hasOwn(rule, "replace");
      if (hasReplace && typeof rule.replace !== "string")
        return invalid(value);
      try {
        new RegExp(rule.pattern, "g");
      } catch {
        return invalid(value);
      }
      rules.push({
        pattern: rule.pattern,
        ...hasReplace ? { replace: rule.replace } : {}
      });
    }
    common.redact_extra_rules = rules;
  }
  return { status: "valid", common, raw: value, diagnostics };
}
function readCommonConfigFile(path) {
  try {
    if (!statSync(path).isFile())
      return invalid();
  } catch (error2) {
    if (error2.code === "ENOENT") {
      try {
        lstatSync(path);
      } catch (lstatError) {
        if (lstatError.code === "ENOENT") {
          return { status: "absent", common: {}, diagnostics: [] };
        }
      }
    }
    return invalid();
  }
  try {
    return parseCommonConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return invalid();
  }
}
function resolveField(sources, field) {
  return sources.find((source) => source[field] !== void 0)?.[field];
}
function mergeCommonConfig(sources, options = {}) {
  const { harness = {}, root = {}, user = {}, userRoot = {}, env = {}, defaults = {} } = sources;
  const files = [harness, root, user, userRoot];
  const precedence = [env, ...files, defaults];
  const switches = options.envFirst ? precedence : [...files, env, defaults];
  const merged = { enabled: false, defaultMuted: false, redact: true };
  for (const field of ["enabled", "defaultMuted"]) {
    merged[field] = resolveField(switches, field) ?? COMMON_BOOLEAN_SETTINGS[field].default;
  }
  merged.api_key = resolveField(precedence, "api_key");
  merged.api_url = resolveField(precedence, "api_url");
  merged.project = resolveField(precedence, "project");
  merged.replicas = resolveField(precedence, "replicas");
  merged.redact = resolveField(precedence, "redact") ?? true;
  merged.redact_extra_rules = resolveField(precedence, "redact_extra_rules");
  if (precedence.some((source) => source.metadata !== void 0)) {
    merged.metadata = [...precedence].reverse().reduce((metadata, source) => ({ ...metadata, ...source.metadata }), {});
  }
  return merged;
}
function toSdkReplicas(replicas) {
  return replicas?.map((replica) => ({
    ...replica.api_url === void 0 ? {} : { apiUrl: replica.api_url },
    ...replica.api_key === void 0 ? {} : { apiKey: replica.api_key },
    ...replica.project === void 0 ? {} : { projectName: replica.project },
    ...replica.updates === void 0 ? {} : { updates: replica.updates }
  }));
}

// dist/config.js
import { userInfo } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

// dist/logger.js
import { appendFileSync, mkdirSync, statSync as statSync2, renameSync } from "node:fs";
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
    if (statSync2(LOG_FILE).size >= MAX_LOG_BYTES) {
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

// dist/version.js
var LS_INTEGRATION_VERSION = true ? "0.4.0" : process.env.LANGSMITH_CURSOR_INTEGRATION_VERSION || void 0;

// dist/config.js
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
      error("Skipping invalid LANGSMITH_CURSOR_REDACT_EXTRA rule.");
      continue;
    }
    valid.push(rule);
  }
  return parsed.length === 0 || valid.length > 0 ? valid : void 0;
}
function readConfigFile(file) {
  const result = readCommonConfigFile(file);
  for (const diagnostic of result.diagnostics)
    error(diagnostic);
  const extensions = {};
  const raw = result.raw;
  if (raw) {
    for (const field of ["attachments", "system_prompt"]) {
      if (!Object.hasOwn(raw, field))
        continue;
      if (typeof raw[field] === "boolean")
        extensions[field] = raw[field];
      else
        error(`Invalid Cursor config extension ${field}; ignoring field.`);
    }
    if (Object.hasOwn(raw, "cursor_db_path")) {
      if (typeof raw.cursor_db_path === "string")
        extensions.cursor_db_path = raw.cursor_db_path;
      else
        error("Invalid Cursor config extension cursor_db_path; ignoring field.");
    }
  }
  return { common: result.common, extensions };
}
function parseStrictBoolean(value) {
  if (value.toLowerCase() === "true")
    return true;
  if (value.toLowerCase() === "false")
    return false;
  return void 0;
}
var BOOLEAN_SETTINGS = {
  enabled: {
    env: "TRACE_TO_LANGSMITH",
    parse: parseBoolean,
    ...COMMON_BOOLEAN_SETTINGS.enabled
  },
  defaultMuted: {
    env: "LANGSMITH_CURSOR_DEFAULT_MUTED",
    parse: parseStrictBoolean,
    ...COMMON_BOOLEAN_SETTINGS.defaultMuted
  }
};
function envBoolean(field) {
  const setting = BOOLEAN_SETTINGS[field];
  const env = process.env[setting.env];
  if (env === void 0)
    return void 0;
  return setting.parse(env) ?? setting.restrictive;
}
function getEnv(suffix) {
  return process.env[`LANGSMITH_CURSOR_${suffix}`] ?? process.env[`LANGSMITH_${suffix}`];
}
function normalizeReplicas(replicas) {
  if (!Array.isArray(replicas) || replicas.some((r) => !r || typeof r !== "object"))
    return void 0;
  return replicas.map((r) => Array.isArray(r) ? r : {
    ...r.api_url || r.apiUrl ? { apiUrl: r.api_url ?? r.apiUrl } : {},
    ...r.api_key || r.apiKey ? { apiKey: r.api_key ?? r.apiKey } : {},
    ...r.project || r.projectName ? { projectName: r.project ?? r.projectName } : {},
    ...r.updates ? { updates: r.updates } : {}
  });
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
  const userRootFile = readConfigFile(join(homedir2(), ".langsmith-plugins.json"));
  const globalFile = readConfigFile(join(homedir2(), ".cursor", "langsmith.json"));
  const rootFile = readConfigFile(join(cwd, "langsmith-plugins.json"));
  const localFile = readConfigFile(join(cwd, ".cursor", "langsmith.json"));
  const envMetadata = parseJson(getEnv("METADATA"));
  const envReplicas = parseJson(getEnv("RUNS_ENDPOINTS"));
  const envDebug = parseBoolean(getEnv("DEBUG"));
  const common = mergeCommonConfig({
    harness: localFile.common,
    root: rootFile.common,
    user: globalFile.common,
    userRoot: userRootFile.common,
    env: {
      enabled: envBoolean("enabled"),
      defaultMuted: envBoolean("defaultMuted"),
      api_key: getEnv("API_KEY"),
      api_url: getEnv("ENDPOINT"),
      project: getEnv("PROJECT"),
      metadata: envMetadata,
      redact: parseBoolean(getEnv("REDACT"))
    },
    defaults: { api_key: "", api_url: DEFAULT_API_URL, project: DEFAULT_PROJECT }
  }, { envFirst: true });
  const { enabled, defaultMuted, redact } = common;
  const apiKey = common.api_key;
  const apiUrl = common.api_url;
  const project = common.project;
  const debug2 = envDebug ?? false;
  const replicas = normalizeReplicas(envReplicas) ?? toSdkReplicas(common.replicas);
  const attachmentsEnabled = parseBoolean(getEnv("ATTACHMENTS")) ?? localFile.extensions.attachments ?? rootFile.extensions.attachments ?? globalFile.extensions.attachments ?? userRootFile.extensions.attachments ?? true;
  const systemPromptEnabled = parseBoolean(getEnv("SYSTEM_PROMPT")) ?? localFile.extensions.system_prompt ?? rootFile.extensions.system_prompt ?? globalFile.extensions.system_prompt ?? userRootFile.extensions.system_prompt ?? true;
  const cursorDbPath = getEnv("DB_PATH") ?? localFile.extensions.cursor_db_path ?? rootFile.extensions.cursor_db_path ?? globalFile.extensions.cursor_db_path ?? userRootFile.extensions.cursor_db_path;
  const redactExtraRules = parseRedactExtraRules(getEnv("REDACT_EXTRA")) ?? common.redact_extra_rules;
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
  const customMetadata = { ...baseMetadata, ...common.metadata };
  if (enabled && !apiKey && (!replicas || replicas.length === 0)) {
    debug("Config enabled but no API key / replicas resolved");
  }
  return {
    enabled,
    defaultMuted,
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
    error("Tracing enabled but no API key set (langsmith-plugins.json or .cursor/langsmith.json api_key, LANGSMITH_CURSOR_API_KEY, or LANGSMITH_API_KEY) and no replicas configured");
    return null;
  }
  return config;
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

// dist/normalize.js
function isRecord(value) {
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
  const texts = content.filter(isRecord).map((part) => typeof part.text === "string" ? part.text : void 0).filter((text) => text != null && text !== "");
  return texts.length > 0 ? texts.join("\n") : void 0;
}
function extractMcpError(toolName, output) {
  if (!toolName.startsWith(MCP_TOOL_PREFIX))
    return void 0;
  if (!isRecord(output) || output.isError !== true)
    return void 0;
  return mcpContentToText(output.content) ?? "MCP tool returned isError: true";
}

// dist/reducer.js
function touch(conv) {
  conv.updated = (/* @__PURE__ */ new Date()).toISOString();
}
function reducePostToolUse(state, input, nowMs) {
  const conv = getConversationState(state, input.conversation_id);
  if (conv.completedOffGenerations?.includes(input.generation_id))
    return state;
  const turn = conv.turns[input.generation_id] ?? newTurnBuffer(input.generation_id, nowMs);
  turn.model = preferModel(turn.model, input.model);
  const output = parseToolOutput(input.tool_output);
  turn.tools.push({
    tool_use_id: input.tool_use_id,
    name: input.tool_name,
    input: input.tool_input ?? {},
    output,
    // Cursor never fires postToolUseFailure for MCP tools; a failed MCP call
    // arrives here with isError in the output. Flag it so the run is an error.
    error: extractMcpError(input.tool_name, output),
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
