#!/usr/bin/env node

// dist/src/constants.js
var DEFAULT_PROJECT = "cursor";
var CURSOR_INTEGRATION = "cursor";
var CURSOR_ENGINE_WORKER_ARGUMENT_LIMITS = {
  sessionId: 1024,
  cwd: 4096,
  project: 512,
  callerConversationId: 1024
};
var CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
var CURSOR_TURN_SOURCE_DIRECTORY = "cursor-turn-sources-v1";
var CURSOR_TURN_ROUTE_DIRECTORY = "cursor-turn-routes-v1";
var CURSOR_TURN_SOURCE_EVENT_KIND = "cursor-turn-source-v1";
var CURSOR_TURN_ROUTE_EVENT_KIND = "cursor-turn-route-v1";
var CURSOR_EARLY_TOOL_SOURCE_EVENT_PREFIX = "early-tool-";
var CURSOR_NATIVE_TURN_SOURCE_VERSION = 1;
var CURSOR_NATIVE_TURN_ROUTE_VERSION = 1;
var CURSOR_TURN_SOURCE_EVENT_ID_MAX_LENGTH = 1024;
var CURSOR_TURN_ORIGIN_ERRORS = {
  unavailable: "Cursor tracing origin provenance is unavailable",
  cwdUnavailable: "Cursor tracing cwd provenance is unavailable",
  destinationUnavailable: "Cursor tracing destination provenance is unavailable",
  destinationChanged: "Cursor tracing destination changed since the turn started"
};
var CURSOR_NATIVE_SOURCE_ERRORS = {
  offTurn: "Cursor off turns cannot be queued for reconstruction",
  invalidEventId: "Cursor native source event ID is invalid",
  invalidCwd: "Cursor native source cwd is invalid",
  routeUnavailable: "Cursor reconstruction route is unavailable for this account",
  routeInvalid: "Cursor reconstruction route is invalid",
  sourceUnavailable: "Cursor reconstruction source is unavailable for this account",
  sourceRefInvalid: "Cursor reconstruction source reference is invalid",
  sourceTurnMismatch: "Cursor reconstruction source turn does not match its record",
  sourceInvalid: "Cursor reconstruction source is invalid",
  bufferInvalid: "Cursor reconstruction turn buffer is invalid",
  routeWriteFailure: "Could not persist Cursor turn route: ",
  sourceWriteFailure: "Could not persist Cursor turn source: "
};
var READ_TOOLS = /* @__PURE__ */ new Set(["read_file_v2", "ReadFile", "Read"]);
var DEFAULT_SWEEP_IDLE_MINUTES = 360;
var GIT_PROVIDERS_REGEX = {
  github: /[@/](?:github\.com)[:/](.+?)(?:\.git)?\s/,
  gitlab: /[@/](?:gitlab\.com)[:/](.+?)(?:\.git)?\s/,
  bitbucket: /[@/](?:bitbucket\.org)[:/](.+?)(?:\.git)?\s/,
  devAzure: /[@/](?:dev\.azure\.com)[:/](.+?)(?:\.git)?\s/
};
var PROVIDER_HOSTS = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
  devAzure: "dev.azure.com"
};
var LEADING_BYTE_ORDER_MARKS = /^\uFEFF+/;

// dist/src/utils/stdin.js
function readStdin(stream = process.stdin) {
  return new Promise((resolve6, reject) => {
    let data = "";
    stream.setEncoding("utf-8");
    stream.on("data", (chunk) => data += chunk);
    stream.on("end", () => {
      try {
        resolve6(JSON.parse(data.replace(LEADING_BYTE_ORDER_MARKS, "")));
      } catch (err) {
        reject(new Error(`Failed to parse hook input: ${err}`));
      }
    });
    stream.on("error", reject);
  });
}

// node_modules/.pnpm/@langchain+plugins-base@htt_162ae748324fb860f7b803d415a28ef5/node_modules/@langchain/plugins-base/dist/settings/constants.js
var COMMON_BOOLEAN_SETTINGS = {
  enabled: { default: false, restrictive: false },
  defaultMuted: { default: false, restrictive: true }
};

// node_modules/.pnpm/@langchain+plugins-base@htt_162ae748324fb860f7b803d415a28ef5/node_modules/@langchain/plugins-base/dist/settings/common-config.js
import { lstatSync, readFileSync, statSync } from "node:fs";
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
  for (const field2 of ["enabled", "defaultMuted"]) {
    if (!Object.hasOwn(value, field2))
      continue;
    const entry = value[field2];
    common[field2] = typeof entry === "boolean" ? entry : COMMON_BOOLEAN_SETTINGS[field2].restrictive;
    if (typeof entry !== "boolean")
      diagnostics.push(`Invalid ${field2}; using restrictive value.`);
  }
  for (const field2 of ["api_key", "api_url", "project"]) {
    if (!Object.hasOwn(value, field2))
      continue;
    if (typeof value[field2] !== "string")
      return invalid(value);
    common[field2] = value[field2];
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
function resolveField(sources, field2) {
  return sources.find((source) => source[field2] !== void 0)?.[field2];
}
function mergeCommonConfig(sources, options = {}) {
  const { harness = {}, root = {}, user = {}, userRoot = {}, env = {}, defaults = {} } = sources;
  const files = [harness, root, user, userRoot];
  const precedence = [env, ...files, defaults];
  const switches = options.envFirst ? precedence : [...files, env, defaults];
  const merged = { enabled: false, defaultMuted: false, redact: true };
  for (const field2 of ["enabled", "defaultMuted"]) {
    merged[field2] = resolveField(switches, field2) ?? COMMON_BOOLEAN_SETTINGS[field2].default;
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

// dist/src/config.js
import { userInfo } from "node:os";
import { join } from "node:path";

// dist/src/logger.js
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

// dist/src/config.js
import { homedir as homedir2 } from "node:os";

// dist/src/utils/git/repo-metadata.js
import { execSync } from "node:child_process";
function parseRepoName(remoteUrl) {
  for (const [provider2, regex] of Object.entries(GIT_PROVIDERS_REGEX)) {
    const match = remoteUrl.match(regex);
    if (match)
      return { provider: provider2, name: match[1] };
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

// dist/src/config.js
var LS_INTEGRATION_VERSION = true ? "0.5.0" : process.env.LANGSMITH_CURSOR_INTEGRATION_VERSION || void 0;
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
function parsePositiveNumber(value) {
  if (typeof value !== "string" || value.trim().length === 0)
    return void 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : void 0;
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
    for (const field2 of ["attachments", "system_prompt"]) {
      if (!Object.hasOwn(raw, field2))
        continue;
      if (typeof raw[field2] === "boolean")
        extensions[field2] = raw[field2];
      else
        error(`Invalid Cursor config extension ${field2}; ignoring field.`);
    }
    if (Object.hasOwn(raw, "sweep_idle_minutes")) {
      const minutes = raw.sweep_idle_minutes;
      if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0)
        extensions.sweep_idle_minutes = minutes;
      else
        error("Invalid Cursor config extension sweep_idle_minutes; ignoring field.");
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
function envBoolean(field2) {
  const setting = BOOLEAN_SETTINGS[field2];
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
  const sweepIdleMinutes = parsePositiveNumber(getEnv("SWEEP_IDLE_MINUTES")) ?? localFile.extensions.sweep_idle_minutes ?? rootFile.extensions.sweep_idle_minutes ?? globalFile.extensions.sweep_idle_minutes ?? userRootFile.extensions.sweep_idle_minutes ?? DEFAULT_SWEEP_IDLE_MINUTES;
  const cursorDbPath = getEnv("DB_PATH") ?? localFile.extensions.cursor_db_path ?? rootFile.extensions.cursor_db_path ?? globalFile.extensions.cursor_db_path ?? userRootFile.extensions.cursor_db_path;
  const redactExtraRules = parseRedactExtraRules(getEnv("REDACT_EXTRA")) ?? common.redact_extra_rules;
  const stateFilePath = process.env.LANGSMITH_CURSOR_STATE_FILE ?? join(homedir2(), ".cursor", "langsmith-state.json");
  const baseMetadata = { cwd };
  if (LS_INTEGRATION_VERSION)
    baseMetadata.ls_integration_version = LS_INTEGRATION_VERSION;
  if (options?.includeGitMetadata !== false) {
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
  }
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
    redactExtraRules,
    sweepIdleMinutes
  };
}

// dist/src/utils/hook-init.js
function initHook(cwd) {
  const config = loadConfig({ cwd, includeGitMetadata: false });
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

// dist/src/state.js
import { readFileSync as readFileSync2, writeFileSync, mkdirSync as mkdirSync2, openSync, closeSync, unlinkSync, renameSync as renameSync2, fsyncSync } from "node:fs";
import { randomUUID as randomUUID2 } from "node:crypto";

// node_modules/.pnpm/@langchain+plugins-base@htt_162ae748324fb860f7b803d415a28ef5/node_modules/@langchain/plugins-base/dist/storage/file-lock.js
import { chmod, link, lstat, mkdir, readFile, readdir, rmdir, rename, unlink, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { dirname as dirname2, join as join2, resolve as resolve2 } from "node:path";

// node_modules/.pnpm/@langchain+plugins-base@htt_162ae748324fb860f7b803d415a28ef5/node_modules/@langchain/plugins-base/dist/storage/constants.js
var FILE_LOCK_CLAIM_VERSION = 1;
var FILE_LOCK_CLAIM_EXTENSION = ".json";
var FILE_LOCK_DIRECTORY_SUFFIX = ".claims";
var FILE_LOCK_LEGACY_DIRECTORY_SUFFIX = ".lock";
var FILE_LOCK_TIMEOUT_ERROR_NAME = "FileLockTimeoutError";
var FILE_LOCK_TEMP_PREFIX = ".";
var FILE_LOCK_TEMP_SUFFIX = ".tmp";
var FILE_LOCK_EXCLUSIVE_FLAG = "wx";
var FILE_LOCK_ENCODING = "utf-8";
var FILE_LOCK_DEFAULT_TIMEOUT_MS = 5e3;
var FILE_LOCK_POLL_INTERVAL_MS = 10;
var FILE_LOCK_DIRECTORY_MODE = 448;
var FILE_LOCK_FILE_MODE = 384;
var FILE_LOCK_UNSELECTED_TICKET = 0;
var FILE_LOCK_NEGATIVE_TICKET_LIMIT = 0;
var FILE_LOCK_TIMEOUT_MESSAGE = "Timed out waiting for file lock";
var FILE_LOCK_TICKET_LIMIT_MESSAGE = "File lock ticket limit reached";
var FILE_LOCK_RELEASE_MESSAGE = "Could not release file lock claim";
var FILE_LOCK_INVALID_TIMEOUT_MESSAGE = "timeoutMs must be a finite positive number";
var FILE_LOCK_ACQUIRE_MESSAGE = "Could not acquire file lock claim";
var FILE_LOCK_UNSAFE_DIRECTORY_MESSAGE = "Unsafe file lock claims directory";
var FILE_LOCK_EXISTS_CODE = "EEXIST";
var FILE_LOCK_MISSING_CODE = "ENOENT";
var FILE_LOCK_PROCESS_MISSING_CODE = "ESRCH";
var FILE_LOCK_PROCESS_CHECK_SIGNAL = 0;
var FILE_LOCK_RENAME_RETRY_TIMEOUT_MS = 100;
var FILE_LOCK_RENAME_BUSY_CODE = "EPERM";
var FILE_LOCK_WINDOWS_DIRECTORY_CONTENTION_CODES = ["EPERM", "EACCES"];
var FILE_LOCK_COMPATIBLE_ACQUIRE_CLEANUP_MESSAGE = "Could not release the legacy lock gate after shared lock acquisition failed";
var FILE_LOCK_COMPATIBLE_RELEASE_MESSAGE = "Could not release compatible file lock";
var FILE_LOCK_COMPATIBLE_GATE_CHANGED_MESSAGE = "Legacy file lock gate changed before release";

// node_modules/.pnpm/@langchain+plugins-base@htt_162ae748324fb860f7b803d415a28ef5/node_modules/@langchain/plugins-base/dist/storage/errors.js
import { resolve } from "node:path";
var FileLockTimeoutError = class extends Error {
  constructor(filePath) {
    super(`${FILE_LOCK_TIMEOUT_MESSAGE}: ${resolve(filePath)}`);
    this.name = FILE_LOCK_TIMEOUT_ERROR_NAME;
  }
};

// node_modules/.pnpm/@langchain+plugins-base@htt_162ae748324fb860f7b803d415a28ef5/node_modules/@langchain/plugins-base/dist/storage/file-lock.js
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function parseClaim(value, id) {
  if (!isRecord(value))
    return void 0;
  if (value.version !== FILE_LOCK_CLAIM_VERSION || value.id !== id || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.choosing !== "boolean" || typeof value.ticket !== "number" || !Number.isSafeInteger(value.ticket) || value.ticket < FILE_LOCK_NEGATIVE_TICKET_LIMIT || (value.choosing ? value.ticket !== FILE_LOCK_UNSELECTED_TICKET : value.ticket === FILE_LOCK_UNSELECTED_TICKET)) {
    return void 0;
  }
  return value;
}
async function processIsAlive(pid) {
  try {
    process.kill(pid, FILE_LOCK_PROCESS_CHECK_SIGNAL);
    return true;
  } catch (error2) {
    const code = error2.code;
    if (code === FILE_LOCK_PROCESS_MISSING_CODE)
      return false;
    return void 0;
  }
}
async function removeFile(filePath) {
  try {
    await unlink(filePath);
    return true;
  } catch (error2) {
    if (error2.code === FILE_LOCK_MISSING_CODE)
      return true;
    return false;
  }
}
async function publishClaim(filePath, claim, create, deadline) {
  const temporaryPath = join2(dirname2(filePath), `${FILE_LOCK_TEMP_PREFIX}${claim.id}.${randomUUID()}${FILE_LOCK_TEMP_SUFFIX}`);
  try {
    await writeFile(temporaryPath, JSON.stringify(claim), {
      flag: FILE_LOCK_EXCLUSIVE_FLAG,
      mode: FILE_LOCK_FILE_MODE
    });
    if (create)
      await link(temporaryPath, filePath);
    else {
      const replacementDeadline = deadline ?? performance.now() + FILE_LOCK_RENAME_RETRY_TIMEOUT_MS;
      for (; ; ) {
        try {
          await rename(temporaryPath, filePath);
          break;
        } catch (error2) {
          if (error2.code !== FILE_LOCK_RENAME_BUSY_CODE)
            throw error2;
          await waitForNextScan(replacementDeadline, filePath);
        }
      }
    }
  } finally {
    await removeFile(temporaryPath);
  }
}
async function createClaim(claimDirectory) {
  for (; ; ) {
    const id = randomUUID();
    const claim = {
      version: FILE_LOCK_CLAIM_VERSION,
      id,
      pid: process.pid,
      choosing: true,
      ticket: FILE_LOCK_UNSELECTED_TICKET
    };
    try {
      await publishClaim(join2(claimDirectory, `${id}${FILE_LOCK_CLAIM_EXTENSION}`), claim, true);
      return claim;
    } catch (error2) {
      if (error2.code !== FILE_LOCK_EXISTS_CODE)
        throw error2;
    }
  }
}
async function scanClaims(claimDirectory) {
  const entries = await readdir(claimDirectory, { withFileTypes: true });
  const claims = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(FILE_LOCK_CLAIM_EXTENSION))
      continue;
    const id = entry.name.slice(0, -FILE_LOCK_CLAIM_EXTENSION.length);
    if (!entry.isFile())
      return { claims, blocked: true };
    let value;
    try {
      value = JSON.parse(await readFile(join2(claimDirectory, entry.name), FILE_LOCK_ENCODING));
    } catch (error2) {
      if (error2.code === FILE_LOCK_MISSING_CODE)
        continue;
      return { claims, blocked: true };
    }
    const claim = parseClaim(value, id);
    if (!claim)
      return { claims, blocked: true };
    const alive = await processIsAlive(claim.pid);
    if (alive === false) {
      if (!await removeFile(join2(claimDirectory, entry.name)))
        return { claims, blocked: true };
      continue;
    }
    if (alive === void 0)
      return { claims, blocked: true };
    claims.push(claim);
  }
  return { claims, blocked: false };
}
function claimPath(claimDirectory, id) {
  return join2(claimDirectory, `${id}${FILE_LOCK_CLAIM_EXTENSION}`);
}
function hasClaimState(claims, id, choosing, ticket) {
  const claim = claims.find((peer) => peer.id === id);
  return claim?.choosing === choosing && claim.ticket === ticket;
}
function makeHandle(claimDirectory, claim) {
  let releasePromise;
  return {
    release() {
      releasePromise ??= removeFile(claimPath(claimDirectory, claim.id)).then((removed) => {
        if (!removed)
          throw new Error(FILE_LOCK_RELEASE_MESSAGE);
      });
      return releasePromise;
    }
  };
}
async function beginClaim(filePath) {
  const claimDirectory = `${resolve2(filePath)}${FILE_LOCK_DIRECTORY_SUFFIX}`;
  await assertSafeClaimDirectory(claimDirectory);
  await mkdir(claimDirectory, { recursive: true, mode: FILE_LOCK_DIRECTORY_MODE });
  await assertSafeClaimDirectory(claimDirectory);
  await chmod(claimDirectory, FILE_LOCK_DIRECTORY_MODE);
  return { claimDirectory, claim: await createClaim(claimDirectory) };
}
async function assertSafeClaimDirectory(claimDirectory) {
  let stat;
  try {
    stat = await lstat(claimDirectory);
  } catch (error2) {
    if (error2.code === FILE_LOCK_MISSING_CODE)
      return;
    throw error2;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(FILE_LOCK_UNSAFE_DIRECTORY_MESSAGE);
}
async function acquireClaim(filePath, waitForPeers, deadline) {
  const { claimDirectory, claim } = await beginClaim(filePath);
  const ownPath = claimPath(claimDirectory, claim.id);
  let ownedClaim;
  try {
    for (; ; ) {
      const scan = await scanClaims(claimDirectory);
      if (scan.blocked || !hasClaimState(scan.claims, claim.id, true, FILE_LOCK_UNSELECTED_TICKET)) {
        if (!await waitOrReleaseClaim(waitForPeers, deadline, filePath, claimDirectory, claim))
          return void 0;
        continue;
      }
      const peers = scan.claims.filter((peer) => peer.id !== claim.id);
      if (!waitForPeers && peers.length > 0) {
        await makeHandle(claimDirectory, claim).release();
        return void 0;
      }
      let maxTicket = FILE_LOCK_UNSELECTED_TICKET;
      for (const peer of scan.claims)
        maxTicket = Math.max(maxTicket, peer.ticket);
      if (maxTicket >= Number.MAX_SAFE_INTEGER)
        throw new Error(FILE_LOCK_TICKET_LIMIT_MESSAGE);
      ownedClaim = { ...claim, choosing: false, ticket: maxTicket + 1 };
      await publishClaim(ownPath, ownedClaim, false, waitForPeers ? deadline : void 0);
      break;
    }
    const ticketedClaim = ownedClaim;
    if (!ticketedClaim)
      throw new Error(FILE_LOCK_ACQUIRE_MESSAGE);
    for (; ; ) {
      const scan = await scanClaims(claimDirectory);
      if (scan.blocked || !hasClaimState(scan.claims, claim.id, false, ticketedClaim.ticket)) {
        if (!await waitOrReleaseClaim(waitForPeers, deadline, filePath, claimDirectory, claim))
          return void 0;
        continue;
      }
      const peers = scan.claims.filter((peer) => peer.id !== claim.id);
      const blockedByPeer = peers.length > 0 && (!waitForPeers || peers.some((peer) => precedes(peer, ticketedClaim)));
      if (blockedByPeer) {
        if (!await waitOrReleaseClaim(waitForPeers, deadline, filePath, claimDirectory, claim))
          return void 0;
        continue;
      }
      if (waitForPeers && performance.now() > deadline)
        throw timeoutError(filePath);
      return { claimDirectory, claim: ticketedClaim };
    }
  } catch (error2) {
    await makeHandle(claimDirectory, claim).release();
    throw error2;
  }
}
async function acquireLegacyDirectoryGate(filePath, deadline) {
  const gatePath = `${filePath}${FILE_LOCK_LEGACY_DIRECTORY_SUFFIX}`;
  await mkdir(dirname2(filePath), { recursive: true, mode: FILE_LOCK_DIRECTORY_MODE });
  let retriedMissingPermission = false;
  for (; ; ) {
    if (performance.now() >= deadline)
      throw timeoutError(filePath);
    try {
      await mkdir(gatePath, { mode: FILE_LOCK_DIRECTORY_MODE });
      const stat = await lstat(gatePath);
      if (!stat.isDirectory())
        throw new Error(FILE_LOCK_COMPATIBLE_GATE_CHANGED_MESSAGE);
      return { path: gatePath, dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
    } catch (error2) {
      const code = error2.code;
      const permissionDenied = FILE_LOCK_WINDOWS_DIRECTORY_CONTENTION_CODES.some((candidate) => candidate === code);
      if (code !== FILE_LOCK_EXISTS_CODE && !permissionDenied) {
        throw error2;
      }
      let isDirectory = false;
      try {
        isDirectory = (await lstat(gatePath)).isDirectory();
      } catch (statError) {
        if (statError.code === FILE_LOCK_MISSING_CODE) {
          if (code === FILE_LOCK_EXISTS_CODE) {
            retriedMissingPermission = false;
            await waitForNextScan(deadline, filePath);
            continue;
          }
          if (permissionDenied && !retriedMissingPermission) {
            retriedMissingPermission = true;
            continue;
          }
        }
        throw error2;
      }
      if (!isDirectory)
        throw error2;
      retriedMissingPermission = false;
      await waitForNextScan(deadline, filePath);
    }
  }
}
async function releaseLegacyDirectoryGate(gate) {
  let stat;
  try {
    stat = await lstat(gate.path);
  } catch (error2) {
    if (error2.code === FILE_LOCK_MISSING_CODE)
      return;
    throw error2;
  }
  if (!stat.isDirectory() || stat.dev !== gate.dev || stat.ino !== gate.ino || stat.birthtimeMs !== gate.birthtimeMs) {
    throw new Error(FILE_LOCK_COMPATIBLE_GATE_CHANGED_MESSAGE);
  }
  await rmdir(gate.path);
}
async function acquireCompatibleDirectoryFileLock(filePath, options) {
  const resolvedPath = resolve2(filePath);
  const deadline = performance.now() + timeoutMs(options);
  const gate = await acquireLegacyDirectoryGate(resolvedPath, deadline);
  let acquired;
  try {
    acquired = await acquireClaim(resolvedPath, true, deadline);
    if (!acquired)
      throw new Error(FILE_LOCK_ACQUIRE_MESSAGE);
  } catch (error2) {
    try {
      await releaseLegacyDirectoryGate(gate);
    } catch (cleanupError) {
      throw new AggregateError([error2, cleanupError], FILE_LOCK_COMPATIBLE_ACQUIRE_CLEANUP_MESSAGE, {
        cause: cleanupError
      });
    }
    throw error2;
  }
  const sharedHandle = makeHandle(acquired.claimDirectory, acquired.claim);
  let releasePromise;
  return {
    release() {
      releasePromise ??= (async () => {
        const errors = [];
        try {
          await sharedHandle.release();
        } catch (error2) {
          errors.push(error2);
        }
        try {
          await releaseLegacyDirectoryGate(gate);
        } catch (error2) {
          errors.push(error2);
        }
        if (errors.length === 1)
          throw errors[0];
        if (errors.length > 1)
          throw new AggregateError(errors, FILE_LOCK_COMPATIBLE_RELEASE_MESSAGE);
      })();
      return releasePromise;
    }
  };
}
function precedes(left, right) {
  return left.ticket < right.ticket || left.ticket === right.ticket && left.id < right.id;
}
function timeoutError(filePath) {
  return new FileLockTimeoutError(filePath);
}
function timeoutMs(options) {
  const value = options?.timeoutMs ?? FILE_LOCK_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(FILE_LOCK_INVALID_TIMEOUT_MESSAGE);
  return value;
}
function waitForNextScan(deadline, filePath) {
  const remaining = deadline - performance.now();
  if (remaining <= 0)
    return Promise.reject(timeoutError(filePath));
  return new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(FILE_LOCK_POLL_INTERVAL_MS, remaining)));
}
async function waitOrReleaseClaim(waitForPeers, deadline, filePath, claimDirectory, claim) {
  if (!waitForPeers) {
    await makeHandle(claimDirectory, claim).release();
    return false;
  }
  await waitForNextScan(deadline, filePath);
  return true;
}
async function withFileLock(filePath, callback, options) {
  const waitMs = timeoutMs(options);
  const deadline = performance.now() + waitMs;
  const acquired = await acquireClaim(filePath, true, deadline);
  if (!acquired)
    throw new Error(FILE_LOCK_ACQUIRE_MESSAGE);
  try {
    return await callback();
  } finally {
    await makeHandle(acquired.claimDirectory, acquired.claim).release();
  }
}

// dist/src/state.js
import { dirname as dirname3 } from "node:path";

// dist/src/utils/errors.js
function hasFileLockTimeoutError(error2) {
  if (error2 instanceof FileLockTimeoutError)
    return true;
  return error2 instanceof AggregateError && error2.errors.some(hasFileLockTimeoutError);
}

// dist/src/state-constants.js
var TURN_STATE_LOCK_TIMEOUT_MS = 2e3;
var TURN_STATE_LOCK_TIMEOUT_MESSAGE = "Timed out waiting for turn-state lock; confirm no writer is running before removing it";
var TURN_STATE_LOCK_CLEANUP_WARNING = "Turn-state lock cleanup failed; confirm no writer is running before removing it";

// dist/src/state.js
async function acquireLock(stateFilePath) {
  try {
    return await acquireCompatibleDirectoryFileLock(stateFilePath, {
      timeoutMs: TURN_STATE_LOCK_TIMEOUT_MS
    });
  } catch (error2) {
    if (hasFileLockTimeoutError(error2)) {
      throw new Error(TURN_STATE_LOCK_TIMEOUT_MESSAGE, { cause: error2 });
    }
    throw error2;
  }
}
async function releaseLock(lock) {
  try {
    await lock.release();
  } catch {
    warn(TURN_STATE_LOCK_CLEANUP_WARNING);
  }
}
async function atomicUpdateState(stateFilePath, fn) {
  const lock = await acquireLock(stateFilePath);
  try {
    const state = loadState(stateFilePath);
    saveState(stateFilePath, fn(state));
  } finally {
    await releaseLock(lock);
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
  mkdirSync2(dirname3(stateFilePath), { recursive: true, mode: 448 });
  const temp = `${stateFilePath}.${process.pid}.${randomUUID2()}.tmp`;
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
      const fd2 = openSync(dirname3(stateFilePath), "r");
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
function ownEntry(map, id) {
  return map !== void 0 && Object.hasOwn(map, id) ? map[id] : void 0;
}
function setOwnEntry(map, id, value) {
  Object.defineProperty(map, id, { value, writable: true, enumerable: true, configurable: true });
}
function deleteOwnEntry(map, id) {
  delete map[id];
}
function getConversationState(state, conversationId) {
  return ownEntry(state, conversationId) ?? { turns: {}, turn_count: 0, updated: "" };
}
function nextTurnNum(conv) {
  conv.turns_started = (conv.turns_started ?? conv.turn_count) + 1;
  return conv.turns_started;
}
function newTurnBuffer(generationId, startMs, turnNum) {
  return {
    generation_id: generationId,
    turnNum,
    startMs,
    tools: [],
    thoughts: [],
    subagents: []
  };
}
function getTurnBuffer(state, conversationId, generationId) {
  return ownEntry(ownEntry(state, conversationId)?.turns, generationId);
}
var CONVERSATION_MAX_AGE_MS = 24 * 60 * 60 * 1e3;

// dist/src/utils/validation/record.js
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// dist/src/normalize.js
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

// dist/src/reducer.js
function touch(conv, nowMs = Date.now()) {
  conv.updated = new Date(nowMs).toISOString();
}
function dropPendingUpload(conv, generationId) {
  if (!conv.pending)
    return;
  deleteOwnEntry(conv.pending, generationId);
  if (Object.keys(conv.pending).length === 0)
    delete conv.pending;
}
function reopenSweptTurn(conv, generationId) {
  const entry = ownEntry(conv.pending, generationId);
  if (!entry || !conv.sweepFinalizedGenerations?.includes(generationId))
    return false;
  setOwnEntry(conv.turns, generationId, entry.buffer);
  dropPendingUpload(conv, generationId);
  return true;
}
function acceptLateEvent(conv, conversationId, input) {
  const gen = input.generation_id;
  if (conv.completedOffGenerations?.includes(gen))
    return false;
  if (conv.stopFinalizedGenerations?.includes(gen))
    return false;
  if (!conv.sweepFinalizedGenerations?.includes(gen))
    return true;
  if (ownEntry(conv.turns, gen))
    return true;
  if (!reopenSweptTurn(conv, gen))
    return false;
  warn(`Sweep recovered conversation ${conversationId} generation ${gen} too early; reopening it for a late ${input.hook_event_name}`);
  return true;
}
function openTurn(conv, generationId, nowMs) {
  return ownEntry(conv.turns, generationId) ?? newTurnBuffer(generationId, nowMs, nextTurnNum(conv));
}
function reducePostToolUse(state, input, nowMs) {
  const conv = getConversationState(state, input.conversation_id);
  if (!acceptLateEvent(conv, input.conversation_id, input))
    return state;
  const turn = openTurn(conv, input.generation_id, nowMs);
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
  setOwnEntry(conv.turns, input.generation_id, turn);
  touch(conv);
  return { ...state, [input.conversation_id]: conv };
}
function reducePostToolUseFailure(state, input, nowMs) {
  const conv = getConversationState(state, input.conversation_id);
  if (!acceptLateEvent(conv, input.conversation_id, input))
    return state;
  const turn = openTurn(conv, input.generation_id, nowMs);
  turn.model = preferModel(turn.model, input.model);
  turn.tools.push({
    tool_use_id: input.tool_use_id,
    name: input.tool_name,
    input: input.tool_input ?? {},
    error: input.error_message,
    failure_type: input.failure_type,
    duration: input.duration,
    endMs: nowMs
  });
  setOwnEntry(conv.turns, input.generation_id, turn);
  touch(conv);
  return { ...state, [input.conversation_id]: conv };
}

// dist/src/early-tool-capture.js
import { createHash as createHash5 } from "node:crypto";

// dist/src/native-turn-source.js
import { createHash as createHash3 } from "node:crypto";
import { join as join7 } from "node:path";

// node_modules/.pnpm/@langchain+plugins-base@htt_162ae748324fb860f7b803d415a28ef5/node_modules/@langchain/plugins-base/dist/storage/capture/capture-store.js
import { lstat as lstat4 } from "node:fs/promises";
import { join as join6, resolve as resolve5 } from "node:path";

// node_modules/.pnpm/@langchain+plugins-base@htt_162ae748324fb860f7b803d415a28ef5/node_modules/@langchain/plugins-base/dist/storage/capture/constants.js
var CAPTURE_DIRECTORY = "capture-v1";
var CAPTURE_RECORD_VERSION = 2;
var CAPTURE_COMPACTED_RECORD_VERSION = 3;
var CAPTURE_RECONSTRUCTION_JOB_KIND = "reconstruction-job-v1";
var CAPTURE_SOURCE_SNAPSHOT_CLEANUP_VERSION = 1;
var CAPTURE_RECEIPT_VERSION = 1;
var CAPTURE_RECORD_LOCK_DIRECTORY = "record-lock-v1";
var CAPTURE_DIRECTORY_MODE = 448;
var CAPTURE_FILE_MODE = 384;
var CAPTURE_INTEGRATION = /^[a-z][a-z0-9-]{0,62}$/;
var CAPTURE_MAX_IDENTIFIER_BYTES = 4096;
var CAPTURE_HASH = /^[0-9a-f]{64}$/u;
var CAPTURE_EVENT_FILE = /^[0-9a-f]{64}\.json$/u;
var CAPTURE_STAGING_FILE = /^\.[0-9a-f-]{36}\.tmp$/u;
var JSON_ARRAY_INDEX_KEY = /^(0|[1-9]\d*)$/u;

// node_modules/.pnpm/@langchain+plugins-base@htt_162ae748324fb860f7b803d415a28ef5/node_modules/@langchain/plugins-base/dist/storage/capture/paths.js
import { createHash } from "node:crypto";
import { resolve as resolve3, join as join3 } from "node:path";
function validateIntegration(value) {
  if (!CAPTURE_INTEGRATION.test(value))
    throw new TypeError("Invalid integration namespace");
}
function validateIdentifier(value, name) {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > CAPTURE_MAX_IDENTIFIER_BYTES || hasControlCharacter(value)) {
    throw new TypeError(`Invalid ${name}`);
  }
}
function hasControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== void 0 && (codePoint < 32 || codePoint === 127))
      return true;
  }
  return false;
}
function identifierHash(value) {
  return createHash("sha256").update(value).digest("hex");
}
function captureDirectory(root) {
  return join3(resolve3(root), CAPTURE_DIRECTORY);
}
function eventPath(root, scope) {
  return join3(captureDirectory(root), "integrations", scope.integration, "sessions", identifierHash(scope.sessionId), "turns", identifierHash(scope.turnId), "events", `${identifierHash(scope.eventId)}.json`);
}
function receiptPath(root, scope, destination) {
  return join3(captureDirectory(root), "integrations", scope.integration, "sessions", identifierHash(scope.sessionId), "turns", identifierHash(scope.turnId), "receipts", identifierHash(destination), `${identifierHash(scope.eventId)}.json`);
}

// node_modules/.pnpm/@langchain+plugins-base@htt_162ae748324fb860f7b803d415a28ef5/node_modules/@langchain/plugins-base/dist/storage/capture/utils/atomic-file.js
import { constants as fsConstants } from "node:fs";
import { chmod as chmod2, link as link2, lstat as lstat2, mkdir as mkdir2, open, rename as rename2, unlink as unlink2 } from "node:fs/promises";
import { dirname as dirname4, isAbsolute, join as join4, relative, sep } from "node:path";
import { randomUUID as randomUUID3 } from "node:crypto";
async function ensurePrivateDirectory(root, segments) {
  await mkdir2(root, { recursive: true, mode: CAPTURE_DIRECTORY_MODE });
  const rootInfo = await lstat2(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error("Capture root must be a real directory");
  let current = root;
  for (const segment of segments) {
    current = join4(current, segment);
    try {
      await mkdir2(current, { mode: CAPTURE_DIRECTORY_MODE });
    } catch (error2) {
      if (errorCode(error2) !== "EEXIST")
        throw error2;
    }
    const info = await lstat2(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Capture path contains a non-directory");
    await chmod2(current, CAPTURE_DIRECTORY_MODE);
    const checked = await lstat2(current);
    if (!checked.isDirectory() || checked.isSymbolicLink())
      throw new Error("Capture path changed during setup");
  }
  return current;
}
async function publishExclusive(path, contents, beforeCommit) {
  const directory = dirname4(path);
  const stagingPath = join4(directory, `.${randomUUID3()}.tmp`);
  const handle = await open(stagingPath, "wx", CAPTURE_FILE_MODE);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.chmod(CAPTURE_FILE_MODE);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    beforeCommit?.();
    await link2(stagingPath, path);
    await syncDirectory(directory);
    return true;
  } catch (error2) {
    if (errorCode(error2) === "EEXIST")
      return false;
    throw error2;
  } finally {
    await unlink2(stagingPath).catch((error2) => {
      if (errorCode(error2) !== "ENOENT")
        throw error2;
    });
  }
}
async function replacePrivateFile(root, path, contents) {
  if (!await hasRealParentDirectories(root, path))
    throw new Error("Capture record parent directory is missing");
  const original = await lstat2(path);
  if (!original.isFile() || original.isSymbolicLink() || !hasPrivateFileMode(original.mode)) {
    throw new Error("Capture record must be a private regular file");
  }
  const directory = dirname4(path);
  const stagingPath = join4(directory, `.${randomUUID3()}.tmp`);
  let handle;
  let stagingCreated = false;
  let operationFailed = false;
  let operationError;
  try {
    handle = await open(stagingPath, "wx", CAPTURE_FILE_MODE);
    stagingCreated = true;
    await handle.writeFile(contents, "utf8");
    await handle.chmod(CAPTURE_FILE_MODE);
    await handle.sync();
    await handle.close();
    handle = void 0;
    const current = await lstat2(path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino || !hasPrivateFileMode(current.mode)) {
      throw new Error("Capture record changed during replacement");
    }
    await rename2(stagingPath, path);
    await syncDirectory(directory);
  } catch (error2) {
    operationFailed = true;
    operationError = error2;
  }
  const cleanupErrors = [];
  if (handle !== void 0) {
    try {
      await handle.close();
    } catch (error2) {
      cleanupErrors.push(error2);
    }
  }
  if (stagingCreated) {
    try {
      await unlink2(stagingPath);
    } catch (error2) {
      if (errorCode(error2) !== "ENOENT")
        cleanupErrors.push(error2);
    }
  }
  if (operationFailed && cleanupErrors.length > 0)
    throw new AggregateError([operationError, ...cleanupErrors], "Capture replacement failed");
  if (operationFailed)
    throw operationError;
  if (cleanupErrors.length === 1)
    throw cleanupErrors[0];
  if (cleanupErrors.length > 1)
    throw new AggregateError(cleanupErrors, "Capture replacement cleanup failed");
}
function hasPrivateFileMode(mode) {
  return process.platform === "win32" || (mode & 63) === 0;
}
async function readPrivateFile(root, path) {
  if (!await hasRealParentDirectories(root, path))
    return void 0;
  let handle;
  try {
    const info = await lstat2(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Capture record must be a regular file");
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error2) {
    if (errorCode(error2) === "ENOENT")
      return void 0;
    throw error2;
  }
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("Capture record must be a regular file");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
async function hasRealParentDirectories(root, path) {
  const relativeDirectory = relative(root, dirname4(path));
  if (relativeDirectory === ".." || relativeDirectory.startsWith(`..${sep}`) || isAbsolute(relativeDirectory)) {
    throw new Error("Capture path is outside storage root");
  }
  const directories = [root];
  let current = root;
  for (const segment of relativeDirectory.split(sep).filter(Boolean)) {
    current = join4(current, segment);
    directories.push(current);
  }
  for (const directory of directories) {
    let info;
    try {
      info = await lstat2(directory);
    } catch (error2) {
      if (errorCode(error2) === "ENOENT")
        return false;
      throw error2;
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Capture path contains a non-directory");
  }
  return true;
}
async function syncDirectory(path) {
  if (process.platform === "win32")
    return;
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function errorCode(error2) {
  return error2 !== null && typeof error2 === "object" && "code" in error2 && typeof error2.code === "string" ? error2.code : void 0;
}

// node_modules/.pnpm/@langchain+plugins-base@htt_162ae748324fb860f7b803d415a28ef5/node_modules/@langchain/plugins-base/dist/storage/capture/compaction.js
import { createHash as createHash2 } from "node:crypto";

// node_modules/.pnpm/@langchain+plugins-base@htt_162ae748324fb860f7b803d415a28ef5/node_modules/@langchain/plugins-base/dist/storage/capture/utils/serialization.js
function canonicalJson(value) {
  const result = JSON.stringify(canonicalValue(value, /* @__PURE__ */ new Set()));
  if (result === void 0)
    throw new TypeError("Value cannot be serialized as JSON");
  return result;
}
function canonicalValue(value, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value))
    return value;
  if (Array.isArray(value)) {
    if (seen.has(value))
      throw new TypeError("Cyclic data cannot be captured");
    seen.add(value);
    const descriptors2 = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors2).some((key) => typeof key === "symbol" || key !== "length" && (!JSON_ARRAY_INDEX_KEY.test(key) || Number(key) >= value.length))) {
      throw new TypeError("Array properties cannot be captured");
    }
    if (Object.keys(descriptors2).length - 1 < value.length)
      throw new TypeError("Sparse arrays cannot be captured");
    const result2 = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors2[index];
      if (!descriptor?.enumerable || !("value" in descriptor))
        throw new TypeError("Sparse arrays cannot be captured");
      result2.push(canonicalValue(descriptor.value, seen));
    }
    seen.delete(value);
    return result2;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError("Capture data must contain only JSON values");
  }
  if (seen.has(value))
    throw new TypeError("Cyclic data cannot be captured");
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol"))
    throw new TypeError("Symbol keys cannot be captured");
  const result = /* @__PURE__ */ Object.create(null);
  for (const key of Object.keys(descriptors).toSorted()) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor))
      throw new TypeError("Capture data must use enumerable data fields");
    result[key] = canonicalValue(descriptor.value, seen);
  }
  seen.delete(value);
  return result;
}

// node_modules/.pnpm/@langchain+plugins-base@htt_162ae748324fb860f7b803d415a28ef5/node_modules/@langchain/plugins-base/dist/storage/capture/compaction.js
function captureContentDigest(record) {
  if ("compaction" in record && record.compaction !== void 0)
    return record.compaction.originalContentDigest;
  if ("sourceSnapshotCleanup" in record && record.sourceSnapshotCleanup !== void 0)
    return record.sourceSnapshotCleanup.originalContentDigest;
  const content = { ...record };
  delete content.version;
  delete content.capturedAtMs;
  delete content.compaction;
  delete content.sourceSnapshotCleanup;
  return createHash2("sha256").update(canonicalJson(content)).digest("hex");
}
function compactCaptureRecord(record, originalContentDigest) {
  const normalizedPayload = compactPayload(record);
  if (normalizedPayload === void 0)
    return void 0;
  return {
    ...record,
    version: CAPTURE_COMPACTED_RECORD_VERSION,
    normalizedPayload: normalizedPayload.value,
    compaction: {
      version: 1,
      originalContentDigest,
      fields: normalizedPayload.fields
    }
  };
}
function compactReconstructionJobRecord(record, originalContentDigest) {
  if (record.eventKind !== CAPTURE_RECONSTRUCTION_JOB_KIND)
    return void 0;
  const payload = canonicalValue(record.normalizedPayload, /* @__PURE__ */ new Set());
  if (!isJsonObject(payload) || !Object.hasOwn(payload, "sourceSnapshots"))
    return void 0;
  delete payload.sourceSnapshots;
  return {
    ...record,
    normalizedPayload: payload,
    sourceSnapshotCleanup: {
      version: CAPTURE_SOURCE_SNAPSHOT_CLEANUP_VERSION,
      originalContentDigest
    }
  };
}
function validateSourceSnapshotCleanup(value, eventKind, normalizedPayload) {
  if (eventKind !== CAPTURE_RECONSTRUCTION_JOB_KIND || !isObjectRecord(value) || !hasExactKeys(value, ["version", "originalContentDigest"]) || value.version !== CAPTURE_SOURCE_SNAPSHOT_CLEANUP_VERSION || typeof value.originalContentDigest !== "string" || !CAPTURE_HASH.test(value.originalContentDigest) || !isJsonObject(normalizedPayload) || Object.hasOwn(normalizedPayload, "sourceSnapshots")) {
    throw new Error("Invalid reconstruction source snapshot cleanup marker");
  }
  return {
    version: CAPTURE_SOURCE_SNAPSHOT_CLEANUP_VERSION,
    originalContentDigest: value.originalContentDigest
  };
}
function validateCompactionMarker(value, eventKind, normalizedPayload) {
  if (!isObjectRecord(value) || !hasExactKeys(value, ["version", "originalContentDigest", "fields"])) {
    throw new Error("Invalid compacted capture marker");
  }
  if (value.version !== 1 || typeof value.originalContentDigest !== "string" || !CAPTURE_HASH.test(value.originalContentDigest) || !isObjectRecord(value.fields) || !hasExactKeys(value.fields, ["inputs", "outputs"])) {
    throw new Error("Invalid compacted capture marker");
  }
  const payload = isJsonObject(normalizedPayload) ? normalizedPayload : void 0;
  if (payload === void 0)
    throw new Error("Invalid compacted capture payload");
  let target;
  let patchFields;
  if (eventKind === "run-post" && payload.operation === "post" && isJsonObject(payload.run)) {
    target = payload.run;
  } else if (eventKind === "run-patch" && payload.operation === "patch" && isJsonObject(payload.patch) && isJsonObject(payload.patch.values) && Array.isArray(payload.patch.fields) && payload.patch.fields.every((field2) => typeof field2 === "string")) {
    target = payload.patch.values;
    patchFields = payload.patch.fields;
  } else {
    throw new Error("Invalid compacted capture payload");
  }
  const fields = {
    inputs: readCompactedField(value.fields.inputs),
    outputs: readCompactedField(value.fields.outputs)
  };
  if (![fields.inputs, fields.outputs].some((field2) => field2.state === "value"))
    throw new Error("Compacted capture marker has no removed fields");
  for (const field2 of ["inputs", "outputs"]) {
    const state = fields[field2];
    const present = Object.hasOwn(target, field2);
    const included = patchFields?.includes(field2);
    if ((state.state === "preserve" ? !present : present) || included !== void 0 && state.state === "preserve" !== included) {
      throw new Error("Compacted capture field does not match its marker");
    }
  }
  return {
    version: 1,
    originalContentDigest: value.originalContentDigest,
    fields
  };
}
function compactPayload(record) {
  if (record.eventKind !== "run-post" && record.eventKind !== "run-patch")
    return void 0;
  const payloadValue = canonicalValue(record.normalizedPayload, /* @__PURE__ */ new Set());
  if (!isJsonObject(payloadValue))
    return void 0;
  const fields = {
    inputs: { state: "absent" },
    outputs: { state: "absent" }
  };
  let compactedAny = false;
  if (record.eventKind === "run-post") {
    if (payloadValue.operation !== "post" || !isJsonObject(payloadValue.run))
      return void 0;
    for (const field2 of ["inputs", "outputs"]) {
      if (Object.hasOwn(payloadValue.run, field2)) {
        fields[field2] = { state: "value", digest: valueDigest(payloadValue.run[field2]) };
        delete payloadValue.run[field2];
        compactedAny = true;
      }
    }
  } else {
    if (payloadValue.operation !== "patch" || !isJsonObject(payloadValue.patch))
      return void 0;
    if (!Array.isArray(payloadValue.patch.fields) || !isJsonObject(payloadValue.patch.values))
      return void 0;
    const patchFields = payloadValue.patch.fields;
    if (patchFields.some((field2) => typeof field2 !== "string") || new Set(patchFields).size !== patchFields.length) {
      return void 0;
    }
    for (const field2 of ["inputs", "outputs"]) {
      const included = patchFields.includes(field2);
      const present = Object.hasOwn(payloadValue.patch.values, field2);
      if (included !== present)
        return void 0;
      if (present) {
        fields[field2] = {
          state: "value",
          digest: valueDigest(payloadValue.patch.values[field2])
        };
        delete payloadValue.patch.values[field2];
        compactedAny = true;
      }
    }
    payloadValue.patch.fields = patchFields.filter((field2) => field2 !== "inputs" && field2 !== "outputs");
  }
  return compactedAny ? { value: payloadValue, fields } : void 0;
}
function readCompactedField(value) {
  if (!isObjectRecord(value) || typeof value.state !== "string")
    throw new Error("Invalid compacted capture field");
  if (value.state === "preserve" && hasExactKeys(value, ["state"]))
    return { state: "preserve" };
  if (value.state === "absent" && hasExactKeys(value, ["state"]))
    return { state: "absent" };
  if (value.state === "value" && hasExactKeys(value, ["state", "digest"]) && typeof value.digest === "string" && CAPTURE_HASH.test(value.digest)) {
    return { state: "value", digest: value.digest };
  }
  throw new Error("Invalid compacted capture field");
}
function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isObjectRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, keys) {
  if (Object.keys(value).length !== keys.length)
    return false;
  const expected = new Set(keys);
  return Object.keys(value).every((key) => expected.has(key));
}
function valueDigest(value) {
  return createHash2("sha256").update(canonicalJson(value)).digest("hex");
}

// node_modules/.pnpm/@langchain+plugins-base@htt_162ae748324fb860f7b803d415a28ef5/node_modules/@langchain/plugins-base/dist/utils/files/private-directory.js
import { lstat as lstat3, readdir as readdir2 } from "node:fs/promises";
import { isAbsolute as isAbsolute2, join as join5, relative as relative2, resolve as resolve4, sep as sep2 } from "node:path";
async function listPrivateDirectory(root, directory) {
  const storageRoot = resolve4(root);
  const target = resolve4(directory);
  const relativePath = relative2(storageRoot, target);
  if (relativePath === ".." || relativePath.startsWith(`..${sep2}`) || isAbsolute2(relativePath)) {
    throw new Error("Private directory is outside storage root");
  }
  let current = storageRoot;
  for (const segment of ["", ...relativePath.split(sep2).filter(Boolean)]) {
    if (segment)
      current = join5(current, segment);
    const info = await lstatDirectory(current);
    if (!info)
      return void 0;
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Private path contains a non-directory");
  }
  const entries = await readdir2(target, { withFileTypes: true });
  const finalInfo = await lstat3(target);
  if (!finalInfo.isDirectory() || finalInfo.isSymbolicLink())
    throw new Error("Private path changed during enumeration");
  return entries;
}
async function lstatDirectory(path) {
  try {
    return await lstat3(path);
  } catch (error2) {
    if (errorCode2(error2) === "ENOENT")
      return void 0;
    throw error2;
  }
}
function errorCode2(error2) {
  return error2 !== null && typeof error2 === "object" && "code" in error2 && typeof error2.code === "string" ? error2.code : void 0;
}

// node_modules/.pnpm/@langchain+plugins-base@htt_162ae748324fb860f7b803d415a28ef5/node_modules/@langchain/plugins-base/dist/utils/validation/objects.js
function isPlainRecord(value) {
  return value !== null && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function requirePlainRecord(value, name) {
  if (!isPlainRecord(value))
    throw new TypeError(`${name} must be a plain object`);
  return value;
}
function canonicalJsonObject(value, name) {
  return canonicalValue(requirePlainRecord(value, name), /* @__PURE__ */ new Set());
}
function requireSafeEpochMilliseconds(value, name) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) {
    throw new TypeError(`${name} must be a valid millisecond timestamp`);
  }
  return value;
}
function requireNonNegativeInteger(value, name) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

// node_modules/.pnpm/@langchain+plugins-base@htt_162ae748324fb860f7b803d415a28ef5/node_modules/@langchain/plugins-base/dist/storage/capture/capture-store.js
function createCaptureStore(root) {
  const storageRoot = resolve5(root);
  return {
    async capture(input) {
      let record;
      let contents;
      try {
        validateScope(input);
        const dependencies = normalizeDependencies(input.dependencies, input);
        validateIdentifier(input.runId, "run ID");
        validateIdentifier(input.destinationFingerprint, "destination fingerprint");
        validateIdentifier(input.eventKind, "event kind");
        record = {
          version: CAPTURE_RECORD_VERSION,
          capturedAtMs: Date.now(),
          integration: input.integration,
          sessionId: input.sessionId,
          turnId: input.turnId,
          eventId: input.eventId,
          runId: input.runId,
          destinationFingerprint: input.destinationFingerprint,
          eventKind: input.eventKind,
          normalizedPayload: canonicalValue(input.normalizedPayload, /* @__PURE__ */ new Set()),
          turnEvidence: canonicalValue(input.turnEvidence, /* @__PURE__ */ new Set()),
          metadataProvenance: canonicalValue(input.metadataProvenance, /* @__PURE__ */ new Set()),
          ...input.sourceAgeStartedAtMs === void 0 ? {} : {
            sourceAgeStartedAtMs: requireSafeEpochMilliseconds(input.sourceAgeStartedAtMs, "Source age")
          },
          ...input.priorDeliveryAttempts === void 0 ? {} : {
            priorDeliveryAttempts: requireNonNegativeInteger(input.priorDeliveryAttempts, "Prior delivery attempts")
          },
          ...dependencies === void 0 ? {} : { dependencies }
        };
        contents = canonicalJson(record);
      } catch (error2) {
        return failure("SERIALIZATION_FAILED", error2);
      }
      try {
        const path = eventPath(storageRoot, input);
        return await withRecordLock(storageRoot, input, async () => {
          await ensureDirectories(input.integration, input.sessionId, input.turnId, "events");
          if (await publishExclusive(path, contents))
            return { status: "published", record };
          const previous = await readRecord(storageRoot, path);
          if (previous === void 0)
            return {
              status: "failed",
              code: "STORAGE_FAILED",
              message: "Published event disappeared"
            };
          if (!sameScope(previous, input))
            return { status: "conflict" };
          return sameCapture(previous, record) ? { status: "duplicate", record: previous } : { status: "conflict" };
        });
      } catch (error2) {
        return failure("STORAGE_FAILED", error2);
      }
    },
    async read(scope) {
      validateScope(scope);
      const record = await readRecord(storageRoot, eventPath(storageRoot, scope));
      if (record === void 0)
        return void 0;
      if (!sameScope(record, scope))
        throw new Error("Capture namespace does not match");
      return record;
    },
    async compact(scope, expected) {
      try {
        validateScope(scope);
        if (!sameScope(expected, scope))
          throw new TypeError("Capture namespace does not match");
        const expectedOriginalContentDigest = expected.compaction?.originalContentDigest ?? captureContentDigest(expected);
        if (!CAPTURE_HASH.test(expectedOriginalContentDigest))
          throw new TypeError("Invalid original capture digest");
        return await withRecordLock(storageRoot, scope, async () => {
          const path = eventPath(storageRoot, scope);
          const previous = await readRecord(storageRoot, path);
          if (previous === void 0)
            return { status: "missing-capture" };
          const originalContentDigest = previous.compaction?.originalContentDigest ?? captureContentDigest(previous);
          if (originalContentDigest !== expectedOriginalContentDigest)
            return { status: "changed" };
          if (previous.compaction !== void 0)
            return { status: "already-compacted", record: previous };
          const record = compactCaptureRecord(previous, originalContentDigest);
          if (record === void 0)
            return { status: "changed" };
          await replacePrivateFile(storageRoot, path, canonicalJson(record));
          return { status: "compacted", record };
        });
      } catch (error2) {
        return failure("STORAGE_FAILED", error2);
      }
    },
    async compactReconstructionJob(scope, expected, destination) {
      try {
        validateScope(scope);
        validateIdentifier(destination, "destination");
        if (!sameScope(expected, scope) || expected.eventKind !== CAPTURE_RECONSTRUCTION_JOB_KIND)
          throw new TypeError("Capture is not the expected reconstruction job");
        if (destination !== expected.destinationFingerprint)
          throw new TypeError("Reconstruction job destination does not match");
        const expectedOriginalContentDigest = captureContentDigest(expected);
        if (!CAPTURE_HASH.test(expectedOriginalContentDigest))
          throw new TypeError("Invalid original reconstruction job digest");
        return await withRecordLock(storageRoot, scope, async () => {
          const path = eventPath(storageRoot, scope);
          const previous = await readRecord(storageRoot, path);
          if (previous === void 0)
            return { status: "missing-capture" };
          if (captureContentDigest(previous) !== expectedOriginalContentDigest)
            return { status: "changed" };
          if (previous.sourceSnapshotCleanup !== void 0)
            return { status: "already-compacted", record: previous };
          const payload = previous.normalizedPayload;
          if (payload === null || typeof payload !== "object" || Array.isArray(payload) || !Object.hasOwn(payload, "sourceSnapshots")) {
            return { status: "unchanged" };
          }
          const receipt = await readReceipt(storageRoot, receiptPath(storageRoot, scope, destination));
          if (receipt?.outcome !== "delivered" || receipt.destination !== destination || !sameScope(receipt, scope))
            return { status: "not-delivered" };
          const compacted = compactReconstructionJobRecord(previous, expectedOriginalContentDigest);
          if (compacted === void 0)
            return { status: "changed" };
          await replacePrivateFile(storageRoot, path, canonicalJson(compacted));
          return { status: "compacted", record: compacted };
        });
      } catch (error2) {
        return failure("STORAGE_FAILED", error2);
      }
    },
    async enumerate(integration, sessionId) {
      validateIntegration(integration);
      validateIdentifier(sessionId, "session ID");
      const turnsDirectory = join6(captureDirectory(storageRoot), "integrations", integration, "sessions", identifierHash(sessionId), "turns");
      const turns = await listPrivateDirectory(storageRoot, turnsDirectory);
      if (turns === void 0)
        return [];
      const captures = [];
      for (const turn of turns) {
        if (!turn.isDirectory() || turn.isSymbolicLink() || !CAPTURE_HASH.test(turn.name))
          throw new Error("Invalid capture turn directory");
        const eventDirectory = join6(turnsDirectory, turn.name, "events");
        const events = await listPrivateDirectory(storageRoot, eventDirectory);
        if (events === void 0)
          continue;
        for (const event of events) {
          if (event.isSymbolicLink() || !event.isFile())
            throw new Error("Capture event must be a regular file");
          if (CAPTURE_STAGING_FILE.test(event.name))
            continue;
          if (!CAPTURE_EVENT_FILE.test(event.name))
            throw new Error("Invalid capture event path");
          const path = join6(eventDirectory, event.name);
          const record = await readRecord(storageRoot, path);
          if (record === void 0 || record.integration !== integration || record.sessionId !== sessionId || identifierHash(record.turnId) !== turn.name || `${identifierHash(record.eventId)}.json` !== event.name) {
            throw new Error("Capture event namespace does not match");
          }
          const info = await lstat4(path);
          if (!info.isFile() || info.isSymbolicLink() || !Number.isFinite(info.mtimeMs))
            throw new Error("Capture event must be a regular file");
          captures.push({ record, capturedAtMs: record.capturedAtMs });
        }
      }
      return captures.toSorted(compareCaptures);
    },
    async enumerateTurn(integration, sessionId, turnId) {
      return enumerateTurnCaptures(storageRoot, integration, sessionId, turnId);
    },
    async enumerateSessions(integration) {
      validateIntegration(integration);
      const sessionsDirectory = join6(captureDirectory(storageRoot), "integrations", integration, "sessions");
      const directories = await listPrivateDirectory(storageRoot, sessionsDirectory);
      if (directories === void 0)
        return [];
      const sessions = [];
      for (const directory of directories) {
        if (!directory.isDirectory() || directory.isSymbolicLink() || !CAPTURE_HASH.test(directory.name)) {
          throw new Error("Invalid capture session directory");
        }
        const session = await enumerateSession(storageRoot, integration, directory.name);
        if (session === void 0 || session.captures.length === 0)
          continue;
        sessions.push(session);
      }
      return sessions.toSorted((left, right) => left.sessionId === right.sessionId ? 0 : left.sessionId < right.sessionId ? -1 : 1);
    },
    async recordOutcome(input) {
      try {
        validateScope(input);
        validateIdentifier(input.destination, "destination");
        if (input.outcome !== "delivered" && input.outcome !== "dropped")
          throw new TypeError("Invalid outcome");
        if (input.reason !== void 0)
          validateIdentifier(input.reason, "outcome reason");
        return await withRecordLock(storageRoot, input, async () => {
          if (await readRecord(storageRoot, eventPath(storageRoot, input)) === void 0)
            return { status: "missing-capture" };
          const path = receiptPath(storageRoot, input, input.destination);
          await ensureDirectories(input.integration, input.sessionId, input.turnId, "receipts", input.destination);
          const comparable = receiptValue(input, (/* @__PURE__ */ new Date()).toISOString());
          const contents = canonicalJson(comparable);
          if (await publishExclusive(path, contents))
            return { status: "recorded", receipt: comparable };
          const previous = await readReceipt(storageRoot, path);
          if (previous === void 0)
            return {
              status: "failed",
              code: "STORAGE_FAILED",
              message: "Published receipt disappeared"
            };
          return sameReceipt(previous, input) ? { status: "duplicate", receipt: previous } : { status: "conflict" };
        });
      } catch (error2) {
        return failure("STORAGE_FAILED", error2);
      }
    },
    async readOutcome(scope, destination) {
      try {
        validateScope(scope);
        validateIdentifier(destination, "destination");
        if (await readRecord(storageRoot, eventPath(storageRoot, scope)) === void 0)
          return { status: "missing-capture" };
        const receipt = await readReceipt(storageRoot, receiptPath(storageRoot, scope, destination));
        if (receipt === void 0)
          return { status: "pending" };
        return sameScope(receipt, scope) && receipt.destination === destination ? { status: "settled", receipt } : {
          status: "failed",
          code: "STORAGE_FAILED",
          message: "Receipt namespace does not match"
        };
      } catch (error2) {
        return failure("STORAGE_FAILED", error2);
      }
    }
  };
  async function ensureDirectories(integration, sessionId, turnId, collection, destination) {
    const pathSegments = [
      CAPTURE_DIRECTORY,
      "integrations",
      integration,
      "sessions",
      identifierHash(sessionId),
      "turns",
      identifierHash(turnId),
      collection
    ];
    if (destination !== void 0)
      pathSegments.push(identifierHash(destination));
    await ensurePrivateDirectory(storageRoot, pathSegments);
  }
}
function compareCaptures(left, right) {
  if (left.capturedAtMs !== right.capturedAtMs)
    return left.capturedAtMs < right.capturedAtMs ? -1 : 1;
  if (left.record.eventId === right.record.eventId)
    return 0;
  return left.record.eventId < right.record.eventId ? -1 : 1;
}
async function enumerateTurnCaptures(root, integration, sessionId, turnId) {
  validateIntegration(integration);
  validateIdentifier(sessionId, "session ID");
  validateIdentifier(turnId, "turn ID");
  const turnsDirectory = join6(captureDirectory(root), "integrations", integration, "sessions", identifierHash(sessionId), "turns");
  const turns = await listPrivateDirectory(root, turnsDirectory);
  if (turns === void 0)
    return [];
  const turnHash = identifierHash(turnId);
  const turn = turns.find((entry) => entry.name === turnHash);
  if (turn === void 0)
    return [];
  if (!turn.isDirectory() || turn.isSymbolicLink())
    throw new Error("Invalid capture turn directory");
  const eventDirectory = join6(turnsDirectory, turnHash, "events");
  const events = await listPrivateDirectory(root, eventDirectory);
  if (events === void 0)
    return [];
  const captures = [];
  for (const event of events) {
    if (event.isSymbolicLink() || !event.isFile())
      throw new Error("Capture event must be a regular file");
    if (CAPTURE_STAGING_FILE.test(event.name))
      continue;
    if (!CAPTURE_EVENT_FILE.test(event.name))
      throw new Error("Invalid capture event path");
    const path = join6(eventDirectory, event.name);
    const record = await readRecord(root, path);
    if (record === void 0 || record.integration !== integration || record.sessionId !== sessionId || record.turnId !== turnId || `${identifierHash(record.eventId)}.json` !== event.name) {
      throw new Error("Capture event namespace does not match");
    }
    const info = await lstat4(path);
    if (!info.isFile() || info.isSymbolicLink() || !Number.isFinite(info.mtimeMs))
      throw new Error("Capture event must be a regular file");
    captures.push({ record, capturedAtMs: record.capturedAtMs });
  }
  return captures.toSorted(compareCaptures);
}
async function enumerateSession(root, integration, sessionHash) {
  const turnsDirectory = join6(captureDirectory(root), "integrations", integration, "sessions", sessionHash, "turns");
  const turns = await listPrivateDirectory(root, turnsDirectory);
  if (turns === void 0)
    return void 0;
  const captures = [];
  let sessionId;
  for (const turn of turns) {
    if (!turn.isDirectory() || turn.isSymbolicLink() || !CAPTURE_HASH.test(turn.name))
      throw new Error("Invalid capture turn directory");
    const eventDirectory = join6(turnsDirectory, turn.name, "events");
    const events = await listPrivateDirectory(root, eventDirectory);
    if (events === void 0)
      continue;
    for (const event of events) {
      if (event.isSymbolicLink() || !event.isFile())
        throw new Error("Capture event must be a regular file");
      if (CAPTURE_STAGING_FILE.test(event.name))
        continue;
      if (!CAPTURE_EVENT_FILE.test(event.name))
        throw new Error("Invalid capture event path");
      const path = join6(eventDirectory, event.name);
      const record = await readRecord(root, path);
      if (record === void 0 || record.integration !== integration || identifierHash(record.sessionId) !== sessionHash || identifierHash(record.turnId) !== turn.name || `${identifierHash(record.eventId)}.json` !== event.name || sessionId !== void 0 && record.sessionId !== sessionId) {
        throw new Error("Capture event namespace does not match");
      }
      sessionId = record.sessionId;
      const info = await lstat4(path);
      if (!info.isFile() || info.isSymbolicLink() || !Number.isFinite(info.mtimeMs))
        throw new Error("Capture event must be a regular file");
      captures.push({ record, capturedAtMs: record.capturedAtMs });
    }
  }
  if (sessionId === void 0)
    return void 0;
  return { sessionId, captures: captures.toSorted(compareCaptures) };
}
async function withRecordLock(root, scope, operation) {
  validateScope(scope);
  return withRecordLockByHashes(root, scope.integration, identifierHash(scope.sessionId), identifierHash(scope.turnId), identifierHash(scope.eventId), operation);
}
async function withRecordLockByHashes(root, integration, sessionHash, turnHash, eventHash, operation) {
  if (![sessionHash, turnHash, eventHash].every((value) => CAPTURE_HASH.test(value)))
    throw new TypeError("Invalid capture record lock path");
  const directory = await ensurePrivateDirectory(root, [
    CAPTURE_RECORD_LOCK_DIRECTORY,
    "integrations",
    integration,
    "sessions",
    sessionHash,
    "turns",
    turnHash,
    "events"
  ]);
  return withFileLock(join6(directory, `${eventHash}.lock`), operation);
}
function sameCapture(left, right) {
  const leftDigest = left.compaction?.originalContentDigest ?? captureContentDigest(left);
  return leftDigest === captureContentDigest(right);
}
function receiptValue(input, recordedAt) {
  return {
    version: CAPTURE_RECEIPT_VERSION,
    integration: input.integration,
    sessionId: input.sessionId,
    turnId: input.turnId,
    eventId: input.eventId,
    destination: input.destination,
    outcome: input.outcome,
    ...input.reason === void 0 ? {} : { reason: input.reason },
    recordedAt
  };
}
async function readRecord(root, path) {
  const contents = await readPrivateFile(root, path);
  if (contents === void 0)
    return void 0;
  const value = parseObject(contents);
  if (value.version !== CAPTURE_RECORD_VERSION && value.version !== CAPTURE_COMPACTED_RECORD_VERSION || typeof value.capturedAtMs !== "number" || !Number.isSafeInteger(value.capturedAtMs) || !Number.isFinite(new Date(value.capturedAtMs).getTime()) || typeof value.integration !== "string" || typeof value.sessionId !== "string" || typeof value.turnId !== "string" || typeof value.eventId !== "string" || typeof value.runId !== "string" || typeof value.destinationFingerprint !== "string" || typeof value.eventKind !== "string" || !("normalizedPayload" in value) || !("turnEvidence" in value) || !("metadataProvenance" in value)) {
    throw new Error("Unsupported capture record");
  }
  if ("sourceAgeStartedAtMs" in value) {
    requireSafeEpochMilliseconds(value["sourceAgeStartedAtMs"], "Stored source age");
  }
  if ("priorDeliveryAttempts" in value)
    requireNonNegativeInteger(value["priorDeliveryAttempts"], "Stored prior delivery attempts");
  for (const [identifier, name] of [
    [value.runId, "run ID"],
    [value.destinationFingerprint, "destination fingerprint"],
    [value.eventKind, "event kind"]
  ]) {
    validateIdentifier(identifier, name);
  }
  const scope = {
    integration: value.integration,
    sessionId: value.sessionId,
    turnId: value.turnId,
    eventId: value.eventId
  };
  validateScope(scope);
  const dependencies = normalizeDependencies(value.dependencies, scope);
  const normalizedPayload = canonicalValue(value.normalizedPayload, /* @__PURE__ */ new Set());
  const compaction = value.version === CAPTURE_COMPACTED_RECORD_VERSION ? validateCompactionMarker(value.compaction, value.eventKind, normalizedPayload) : void 0;
  if (value.version === CAPTURE_RECORD_VERSION && "compaction" in value)
    throw new Error("Invalid compacted capture marker");
  if (value.version === CAPTURE_COMPACTED_RECORD_VERSION && "sourceSnapshotCleanup" in value)
    throw new Error("Invalid reconstruction source snapshot cleanup marker");
  const sourceSnapshotCleanup = "sourceSnapshotCleanup" in value ? validateSourceSnapshotCleanup(value.sourceSnapshotCleanup, value.eventKind, normalizedPayload) : void 0;
  return {
    ...value,
    normalizedPayload,
    ...dependencies === void 0 ? {} : { dependencies },
    ...compaction === void 0 ? {} : { compaction },
    ...sourceSnapshotCleanup === void 0 ? {} : { sourceSnapshotCleanup }
  };
}
async function readReceipt(root, path) {
  const contents = await readPrivateFile(root, path);
  if (contents === void 0)
    return void 0;
  const value = parseObject(contents);
  if (value.version !== CAPTURE_RECEIPT_VERSION || typeof value.integration !== "string" || typeof value.sessionId !== "string" || typeof value.turnId !== "string" || typeof value.eventId !== "string" || typeof value.destination !== "string" || value.outcome !== "delivered" && value.outcome !== "dropped" || typeof value.recordedAt !== "string" || "reason" in value && typeof value.reason !== "string") {
    throw new Error("Unsupported outcome receipt");
  }
  validateIdentifier(value.destination, "destination");
  if ("reason" in value)
    validateIdentifier(value.reason, "outcome reason");
  const recordedAt = new Date(value.recordedAt);
  if (!Number.isFinite(recordedAt.getTime()) || recordedAt.toISOString() !== value.recordedAt)
    throw new Error("Unsupported outcome receipt");
  return value;
}
function parseObject(contents) {
  const value = JSON.parse(contents);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid storage record");
  return value;
}
function validateScope(scope) {
  validateIntegration(scope.integration);
  validateIdentifier(scope.sessionId, "session ID");
  validateIdentifier(scope.turnId, "turn ID");
  validateIdentifier(scope.eventId, "event ID");
}
function normalizeDependencies(value, dependent) {
  if (value === void 0)
    return void 0;
  if (!Array.isArray(value))
    throw new TypeError("Invalid capture dependencies");
  const seen = /* @__PURE__ */ new Set();
  return value.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item))
      throw new TypeError("Invalid capture dependency");
    const candidate = item;
    if (typeof candidate.integration !== "string" || typeof candidate.sessionId !== "string" || typeof candidate.turnId !== "string" || typeof candidate.eventId !== "string") {
      throw new TypeError("Invalid capture dependency");
    }
    const dependency = {
      integration: candidate.integration,
      sessionId: candidate.sessionId,
      turnId: candidate.turnId,
      eventId: candidate.eventId
    };
    validateScope(dependency);
    if (dependency.integration !== dependent.integration)
      throw new TypeError("Capture dependencies must use the same integration");
    if (sameScope(dependency, dependent))
      throw new TypeError("Capture cannot depend on itself");
    const key = canonicalJson(dependency);
    if (seen.has(key))
      throw new TypeError("Capture dependencies must be unique");
    seen.add(key);
    return dependency;
  });
}
function sameScope(record, scope) {
  return record.integration === scope.integration && record.sessionId === scope.sessionId && record.turnId === scope.turnId && record.eventId === scope.eventId;
}
function sameReceipt(receipt, input) {
  return sameScope(receipt, input) && receipt.destination === input.destination && receipt.outcome === input.outcome && receipt.reason === input.reason;
}
function failure(code, error2) {
  return {
    status: "failed",
    code: errorCode3(error2) ?? code,
    message: error2 instanceof Error ? error2.message : String(error2)
  };
}
function errorCode3(error2) {
  return error2 !== null && typeof error2 === "object" && "code" in error2 && typeof error2.code === "string" ? error2.code : void 0;
}

// dist/src/utils/serialization/json.js
function toJsonValue(value, errorMessage) {
  const encoded = JSON.stringify(value);
  if (encoded === void 0)
    throw new TypeError(errorMessage);
  return JSON.parse(encoded);
}

// node_modules/.pnpm/@langchain+plugins-base@htt_162ae748324fb860f7b803d415a28ef5/node_modules/@langchain/plugins-base/dist/metadata/constants.js
var CODING_AGENT_SCHEMA_VERSION = "coding-agent-v1";
var CODING_AGENT_PURPOSE = "coding";
var CODING_AGENT_RUN_TYPES = [
  "root",
  "llm",
  "tool",
  "subagent",
  "interrupted"
];
var CODING_AGENT_RUN_SCOPES = {
  all: CODING_AGENT_RUN_TYPES,
  rootInterrupted: ["root", "interrupted"],
  subagent: ["subagent"],
  tool: ["tool"],
  llmTool: ["llm", "tool"],
  chain: ["root", "subagent", "interrupted"]
};
var CODING_AGENT_SCHEMA_INTEGRATIONS = [
  "claude-code",
  "openai-codex",
  "deepagents-code",
  "cursor",
  "pi"
];
var CODING_AGENT_SUPPORTED_INTEGRATIONS = [
  "claude-code",
  "cursor",
  "openai-codex"
];
var CODING_AGENT_CORE_INTEGRATIONS = CODING_AGENT_SUPPORTED_INTEGRATIONS;
var CODING_AGENT_CODEX_INTEGRATION = ["openai-codex"];
var CODING_AGENT_AGENT_TYPES = ["root", "subagent", "middleware", "compaction"];
var CODING_AGENT_ALWAYS_FIELD_OPTIONS = {
  requirement: "always"
};
var CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS = {
  requirement: "where_known",
  requiredWhereKnown: true
};
var CODING_AGENT_FIELD_DEFAULTS = {
  appliesTo: CODING_AGENT_RUN_TYPES,
  type: "string",
  allowedValues: null,
  requirement: "contextual",
  requiredWhereKnown: false,
  metadataModeIntegrations: []
};
var CODING_AGENT_STRUCTURAL_FIELD_DEFAULTS = {
  metadataModeIntegrations: CODING_AGENT_CORE_INTEGRATIONS,
  metadataSource: "structural"
};
var CODING_AGENT_PROVIDER_FIELD_DEFAULTS = {
  metadataSource: "provider",
  providerIntegrations: CODING_AGENT_CORE_INTEGRATIONS
};
var CODING_AGENT_INTEGRATION_POLICIES = {
  "claude-code": {
    fullModePrecedence: "custom-wins",
    metadataModeUsesDirectMetadata: true,
    metadataModePreservesToolName: false,
    legacyAliases: true
  },
  cursor: {
    fullModePrecedence: "custom-wins",
    metadataModeUsesDirectMetadata: true,
    metadataModePreservesToolName: true,
    legacyAliases: false
  },
  "openai-codex": {
    fullModePrecedence: "structural-wins",
    metadataModeUsesDirectMetadata: false,
    metadataModePreservesToolName: false,
    legacyAliases: false
  }
};

// node_modules/.pnpm/@langchain+plugins-base@htt_162ae748324fb860f7b803d415a28ef5/node_modules/@langchain/plugins-base/dist/metadata/contract.js
function field(key, options = {}) {
  return { key, ...CODING_AGENT_FIELD_DEFAULTS, ...options };
}
var structural = (key, options = {}) => field(key, { ...CODING_AGENT_STRUCTURAL_FIELD_DEFAULTS, ...options });
var provider = (key, options = {}) => field(key, { ...CODING_AGENT_PROVIDER_FIELD_DEFAULTS, ...options });
var CODING_AGENT_V1_CONTRACT = {
  schemaVersion: CODING_AGENT_SCHEMA_VERSION,
  integrations: CODING_AGENT_SCHEMA_INTEGRATIONS,
  runtimeNames: {
    "claude-code": "Claude Code",
    "openai-codex": "Codex",
    "deepagents-code": "Deep Agents Code",
    cursor: "Cursor",
    pi: "Pi"
  },
  keys: [
    structural("ls_agent_purpose", {
      ...CODING_AGENT_ALWAYS_FIELD_OPTIONS,
      allowedValues: [CODING_AGENT_PURPOSE]
    }),
    structural("ls_integration", {
      ...CODING_AGENT_ALWAYS_FIELD_OPTIONS,
      allowedValues: CODING_AGENT_SCHEMA_INTEGRATIONS
    }),
    structural("ls_agent_runtime", {
      ...CODING_AGENT_ALWAYS_FIELD_OPTIONS,
      allowedValues: ["Claude Code", "Codex", "Deep Agents Code", "Cursor", "Pi"]
    }),
    structural("thread_id", CODING_AGENT_ALWAYS_FIELD_OPTIONS),
    structural("ls_trace_schema_version", {
      ...CODING_AGENT_ALWAYS_FIELD_OPTIONS,
      allowedValues: [CODING_AGENT_SCHEMA_VERSION]
    }),
    structural("ls_agent_type", {
      ...CODING_AGENT_ALWAYS_FIELD_OPTIONS,
      allowedValues: CODING_AGENT_AGENT_TYPES
    }),
    structural("ls_integration_version", CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
    structural("ls_agent_runtime_version", CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
    structural("turn_id", CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
    structural("turn_number", { ...CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS, type: "integer" }),
    field("repository_url", CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
    field("repository_provider", CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
    field("repository_name", CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
    field("git_branch", CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
    field("git_commit_sha", CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
    field("cwd", CODING_AGENT_WHERE_KNOWN_FIELD_OPTIONS),
    field("ls_skill_name", {
      appliesTo: CODING_AGENT_RUN_SCOPES.tool,
      metadataModeIntegrations: CODING_AGENT_CORE_INTEGRATIONS
    }),
    field("ls_attribution_identifier"),
    field("user_id"),
    field("local_username"),
    field("user_email"),
    field("sandbox_type"),
    field("approval_policy", { appliesTo: CODING_AGENT_RUN_SCOPES.rootInterrupted }),
    field("ls_subagent_id", {
      appliesTo: CODING_AGENT_RUN_SCOPES.subagent,
      metadataModeIntegrations: CODING_AGENT_CORE_INTEGRATIONS
    }),
    field("ls_subagent_type", {
      appliesTo: CODING_AGENT_RUN_SCOPES.subagent,
      metadataModeIntegrations: CODING_AGENT_CORE_INTEGRATIONS
    }),
    field("ls_tool_name", {
      appliesTo: CODING_AGENT_RUN_SCOPES.tool,
      metadataModeIntegrations: CODING_AGENT_CORE_INTEGRATIONS
    }),
    provider("ls_provider", {
      appliesTo: CODING_AGENT_RUN_SCOPES.llmTool,
      metadataModeIntegrations: CODING_AGENT_CODEX_INTEGRATION
    }),
    provider("ls_model_type", {
      appliesTo: CODING_AGENT_RUN_SCOPES.llmTool,
      metadataModeIntegrations: CODING_AGENT_CODEX_INTEGRATION,
      providerIntegrations: CODING_AGENT_CODEX_INTEGRATION
    }),
    provider("ls_message_format", {
      metadataModeIntegrations: CODING_AGENT_CODEX_INTEGRATION,
      providerIntegrations: CODING_AGENT_CODEX_INTEGRATION
    }),
    provider("codex_cli_version", {
      metadataModeIntegrations: CODING_AGENT_CODEX_INTEGRATION,
      providerIntegrations: CODING_AGENT_CODEX_INTEGRATION
    }),
    provider("ls_raw_aggregated_usage", {
      appliesTo: CODING_AGENT_RUN_SCOPES.chain,
      type: "object",
      metadataModeIntegrations: CODING_AGENT_CODEX_INTEGRATION,
      providerIntegrations: CODING_AGENT_CODEX_INTEGRATION
    }),
    provider("ls_invocation_params", {
      appliesTo: CODING_AGENT_RUN_SCOPES.llmTool,
      type: "object"
    }),
    field("usage_metadata", {
      type: "object",
      metadataModeIntegrations: CODING_AGENT_CORE_INTEGRATIONS,
      metadataSource: "explicit"
    }),
    field("ls_model_name", {
      metadataModeIntegrations: CODING_AGENT_CORE_INTEGRATIONS,
      metadataSource: "explicit"
    })
  ],
  integrationPolicies: CODING_AGENT_INTEGRATION_POLICIES
};

// dist/src/metadata.js
function skillNameFromTool(toolName, toolInput) {
  if (!READ_TOOLS.has(toolName))
    return void 0;
  const input = toolInput;
  const filePath = input?.path ?? input?.file_path;
  if (typeof filePath !== "string")
    return void 0;
  const segments = filePath.split(/[/\\]/);
  const file = segments.pop();
  const name = segments.pop();
  if (file !== "SKILL.md" || !name || name.startsWith("."))
    return void 0;
  return segments.includes("skills") ? name : void 0;
}

// dist/src/utils/validation/text.js
function isValidBoundedText(value, maxLength) {
  return value.trim().length > 0 && value.length <= maxLength && !CONTROL_CHARACTER_PATTERN.test(value);
}

// dist/src/native-turn-source.js
function cursorTurnSourceRef(sessionId, conversationId, turnId, accountFingerprint, sourceEventId) {
  return createHash3("sha256").update(JSON.stringify([
    CURSOR_INTEGRATION,
    sessionId,
    conversationId,
    turnId,
    accountFingerprint,
    sourceEventId,
    "native-source"
  ])).digest("hex");
}
async function captureCursorNativeTurnSource(input) {
  if (input.buffer.tracingMode === "off") {
    throw new Error(CURSOR_NATIVE_SOURCE_ERRORS.offTurn);
  }
  if (!isValidBoundedText(input.sourceEventId, CURSOR_TURN_SOURCE_EVENT_ID_MAX_LENGTH)) {
    throw new Error(CURSOR_NATIVE_SOURCE_ERRORS.invalidEventId);
  }
  if (!isValidBoundedText(input.cwd, CURSOR_ENGINE_WORKER_ARGUMENT_LIMITS.cwd)) {
    throw new Error(CURSOR_NATIVE_SOURCE_ERRORS.invalidCwd);
  }
  const sourceRef = cursorTurnSourceRef(input.sessionId, input.conversationId, input.buffer.generation_id, input.accountFingerprint, input.sourceEventId);
  const source = {
    version: CURSOR_NATIVE_TURN_SOURCE_VERSION,
    sourceEventId: input.sourceEventId,
    conversationId: input.conversationId,
    turnNum: input.turnNum,
    buffer: sourceBuffer(input.buffer)
  };
  const route = {
    version: CURSOR_NATIVE_TURN_ROUTE_VERSION,
    cwd: input.cwd
  };
  const base = {
    integration: CURSOR_INTEGRATION,
    sessionId: input.sessionId,
    turnId: input.buffer.generation_id,
    eventId: sourceRef,
    runId: sourceRef,
    destinationFingerprint: input.accountFingerprint,
    turnEvidence: { childRunIds: [], closureState: "open" },
    metadataProvenance: {},
    sourceAgeStartedAtMs: input.buffer.startMs
  };
  const routes = routeStore(input.storageRoot, input.accountFingerprint);
  const routeResult = await routes.capture({
    ...base,
    eventKind: CURSOR_TURN_ROUTE_EVENT_KIND,
    normalizedPayload: toJsonValue(route, "Cursor turn source is not serializable")
  });
  let storedRoute;
  if (routeResult.status === "published" || routeResult.status === "duplicate") {
    storedRoute = parseRouteRecord(routeResult.record, input, sourceRef);
  } else if (routeResult.status === "conflict") {
    storedRoute = parseRouteRecord(await routes.read({
      integration: CURSOR_INTEGRATION,
      sessionId: input.sessionId,
      turnId: input.buffer.generation_id,
      eventId: sourceRef
    }), input, sourceRef);
  } else {
    throw new Error(`${CURSOR_NATIVE_SOURCE_ERRORS.routeWriteFailure}${routeResult.status}`);
  }
  const sources = sourceStore(input.storageRoot, input.accountFingerprint);
  const scope = {
    integration: CURSOR_INTEGRATION,
    sessionId: input.sessionId,
    turnId: input.buffer.generation_id,
    eventId: sourceRef
  };
  const existing = await sources.read(scope);
  if (existing) {
    return {
      sourceRef,
      source: parseSourceRecord(existing, input, sourceRef),
      route: storedRoute
    };
  }
  const sourceResult = await sources.capture({
    ...base,
    eventKind: CURSOR_TURN_SOURCE_EVENT_KIND,
    normalizedPayload: toJsonValue(source, "Cursor turn source is not serializable")
  });
  if (sourceResult.status === "published" || sourceResult.status === "duplicate") {
    return {
      sourceRef,
      source: parseSourceRecord(sourceResult.record, input, sourceRef),
      route: storedRoute
    };
  }
  if (sourceResult.status === "conflict") {
    const winner = await sources.read(scope);
    if (winner) {
      return {
        sourceRef,
        source: parseSourceRecord(winner, input, sourceRef),
        route: storedRoute
      };
    }
  }
  throw new Error(`${CURSOR_NATIVE_SOURCE_ERRORS.sourceWriteFailure}${sourceResult.status}`);
}
function parseSourceRecord(record, input, sourceRef) {
  if (!record || record.integration !== CURSOR_INTEGRATION || record.sessionId !== input.sessionId || record.turnId !== input.buffer.generation_id || record.eventId !== sourceRef || record.runId !== sourceRef || record.destinationFingerprint !== input.accountFingerprint || record.eventKind !== CURSOR_TURN_SOURCE_EVENT_KIND) {
    throw new Error(CURSOR_NATIVE_SOURCE_ERRORS.sourceUnavailable);
  }
  const source = parseSource(record.normalizedPayload);
  if (source.conversationId !== input.conversationId || source.buffer.generation_id !== record.turnId) {
    throw new Error(CURSOR_NATIVE_SOURCE_ERRORS.sourceTurnMismatch);
  }
  return source;
}
function parseRouteRecord(record, input, sourceRef) {
  if (!record || record.integration !== CURSOR_INTEGRATION || record.sessionId !== input.sessionId || record.turnId !== input.buffer.generation_id || record.eventId !== sourceRef || record.runId !== sourceRef || record.destinationFingerprint !== input.accountFingerprint || record.eventKind !== CURSOR_TURN_ROUTE_EVENT_KIND) {
    throw new Error(CURSOR_NATIVE_SOURCE_ERRORS.routeUnavailable);
  }
  return parseRoute(record.normalizedPayload);
}
function sourceStore(storageRoot, accountFingerprint) {
  return createCaptureStore(join7(storageRoot, CURSOR_TURN_SOURCE_DIRECTORY, accountHash(accountFingerprint)));
}
function routeStore(storageRoot, accountFingerprint) {
  return createCaptureStore(join7(storageRoot, CURSOR_TURN_ROUTE_DIRECTORY, accountHash(accountFingerprint)));
}
function accountHash(accountFingerprint) {
  return createHash3("sha256").update(accountFingerprint).digest("hex");
}
function sourceBuffer(buffer) {
  if (buffer.tracingMode === "full") {
    return {
      ...structuredClone(buffer),
      subagents: buffer.subagents.filter((subagent) => subagent.tracingMode !== "off").map((subagent) => sourceSubagent(subagent, true))
    };
  }
  if (buffer.tracingMode === "off") {
    throw new Error(CURSOR_NATIVE_SOURCE_ERRORS.offTurn);
  }
  const origin = buffer.origin;
  return {
    ...buffer,
    tracingMode: "metadata",
    prompt: void 0,
    finalText: void 0,
    thoughts: [],
    origin: origin ? {
      project: origin.project,
      ...origin.userEmail === void 0 ? {} : { userEmail: origin.userEmail },
      ...origin.runtimeVersion === void 0 ? {} : { runtimeVersion: origin.runtimeVersion }
    } : void 0,
    tools: buffer.tools.map(metadataTool),
    subagents: buffer.subagents.filter((subagent) => subagent.tracingMode !== "off").map((subagent) => sourceSubagent(subagent, false))
  };
}
function sourceSubagent(subagent, allowFull) {
  if (allowFull && subagent.tracingMode === "full")
    return structuredClone(subagent);
  return {
    ...subagent,
    tracingMode: "metadata",
    task: "",
    description: void 0,
    resultText: void 0,
    systemPrompt: void 0,
    tools: subagent.tools?.map(metadataTool)
  };
}
function metadataTool(tool) {
  const skillName = skillNameFromTool(tool.name, tool.input);
  return {
    ...tool,
    input: skillName ? { path: `skills/${skillName}/SKILL.md` } : {},
    output: void 0,
    error: tool.error === void 0 ? void 0 : "error"
  };
}
function parseSource(value) {
  if (!isRecord2(value) || value.version !== CURSOR_NATIVE_TURN_SOURCE_VERSION || typeof value.sourceEventId !== "string" || !isValidBoundedText(value.sourceEventId, CURSOR_TURN_SOURCE_EVENT_ID_MAX_LENGTH) || typeof value.conversationId !== "string") {
    throw new Error(CURSOR_NATIVE_SOURCE_ERRORS.sourceInvalid);
  }
  const turnNum = value.turnNum;
  const buffer = value.buffer;
  if (typeof turnNum !== "number" || !Number.isSafeInteger(turnNum) || !isTurnBuffer(buffer)) {
    throw new Error(CURSOR_NATIVE_SOURCE_ERRORS.bufferInvalid);
  }
  return {
    version: CURSOR_NATIVE_TURN_SOURCE_VERSION,
    sourceEventId: value.sourceEventId,
    conversationId: value.conversationId,
    turnNum,
    buffer
  };
}
function parseRoute(value) {
  if (!isRecord2(value) || value.version !== CURSOR_NATIVE_TURN_ROUTE_VERSION || typeof value.cwd !== "string" || !isValidBoundedText(value.cwd, CURSOR_ENGINE_WORKER_ARGUMENT_LIMITS.cwd)) {
    throw new Error(CURSOR_NATIVE_SOURCE_ERRORS.routeInvalid);
  }
  return { version: CURSOR_NATIVE_TURN_ROUTE_VERSION, cwd: value.cwd };
}
function isTurnBuffer(value) {
  if (!isRecord2(value))
    return false;
  return typeof value.generation_id === "string" && Number.isSafeInteger(value.startMs) && Array.isArray(value.tools) && Array.isArray(value.thoughts) && Array.isArray(value.subagents);
}

// dist/src/turn-origin.js
import { dirname as dirname5 } from "node:path";

// node_modules/.pnpm/@langchain+plugins-base@htt_162ae748324fb860f7b803d415a28ef5/node_modules/@langchain/plugins-base/dist/tracing/upload/destination-identity.js
import { createHash as createHash4 } from "node:crypto";

// node_modules/.pnpm/@langchain+plugins-base@htt_162ae748324fb860f7b803d415a28ef5/node_modules/@langchain/plugins-base/dist/tracing/upload/constants.js
var UPLOAD_ACCOUNT_FINGERPRINT_PREFIX = "account_";
var UPLOAD_DESTINATION_ID_PREFIX = "destination_";
var UPLOAD_FINGERPRINT_LENGTH = 32;
var UPLOAD_CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
var UPLOAD_API_URL_TRAILING_SLASH_PATTERN = /\/$/;
var UPLOAD_REPLICA_UUID_V5_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
var UPLOAD_REPLICA_UUID_V5_NAMESPACE_BYTES = Buffer.from(UPLOAD_REPLICA_UUID_V5_NAMESPACE.replaceAll("-", ""), "hex");
var UPLOAD_REPLICA_IDENTITY_UPDATE_FIELDS = /* @__PURE__ */ new Set([
  "id",
  "name",
  "run_type",
  "start_time",
  "parent_run_id",
  "session_id",
  "session_name",
  "trace_id",
  "dotted_order"
]);
var UPLOAD_REPLICA_PATCH_UPDATE_FIELDS = /* @__PURE__ */ new Set([
  "inputs",
  "outputs",
  "end_time",
  "extra",
  "tags",
  "error",
  "serialized",
  "reference_example_id",
  "events"
]);

// node_modules/.pnpm/@langchain+plugins-base@htt_162ae748324fb860f7b803d415a28ef5/node_modules/@langchain/plugins-base/dist/tracing/upload/destination-identity.js
function resolveUploadDestinationIdentities(options) {
  if (!Array.isArray(options.destinations) || options.destinations.length === 0) {
    throw new TypeError("At least one upload destination is required");
  }
  if (options.replicas !== void 0 && !Array.isArray(options.replicas)) {
    throw new TypeError("Upload replicas must be an array");
  }
  if (typeof options.redact !== "boolean")
    throw new TypeError("A redaction setting is required");
  const replicas = options.replicas ?? [];
  if (replicas.length > 0 && options.destinations.length !== 1) {
    throw new TypeError("A replica upload requires exactly one primary destination");
  }
  const primary = options.destinations[0];
  const primaryProjectName = replicas.length === 0 || primary === void 0 ? void 0 : normalizeRequiredText(primary.projectName, "project name");
  const destinations = replicas.length === 0 ? options.destinations.map((destination) => resolveDestination(destination)) : replicas.map((replica) => resolveReplicaDestination(replica, primary, primaryProjectName));
  const ids = /* @__PURE__ */ new Set();
  for (const destination of destinations) {
    if (ids.has(destination.id))
      throw new TypeError("Upload destinations must be unique");
    ids.add(destination.id);
  }
  const fingerprints = destinations.map(({ id }) => id).toSorted();
  const accountFingerprint = `${UPLOAD_ACCOUNT_FINGERPRINT_PREFIX}${fingerprint(JSON.stringify({
    destinations: fingerprints,
    redact: options.redact,
    redactExtraRules: options.redactExtraRules ?? null
  }))}`;
  return { accountFingerprint, destinations };
}
function resolveDestination(config, sourceProjectName, updates) {
  if (!config || typeof config !== "object")
    throw new TypeError("Invalid upload destination");
  if (typeof config.apiKey !== "string" || config.apiKey.trim().length === 0) {
    throw new TypeError("An API key is required for each upload destination");
  }
  const apiUrl = normalizeApiUrl(config.apiUrl);
  const projectName = normalizeRequiredText(config.projectName, "project name");
  const workspaceId = config.workspaceId === void 0 ? void 0 : normalizeRequiredText(config.workspaceId, "workspace ID");
  const identity = JSON.stringify({
    apiKey: config.apiKey,
    apiUrl,
    projectName,
    workspaceId: workspaceId ?? null,
    ...sourceProjectName === void 0 ? {} : { sourceProjectName, updates: updates ?? null }
  });
  const id = `${UPLOAD_DESTINATION_ID_PREFIX}${fingerprint(identity)}`;
  return {
    id,
    apiKey: config.apiKey,
    apiUrl,
    projectName,
    ...workspaceId === void 0 ? {} : { workspaceId },
    ...sourceProjectName === void 0 ? {} : { sourceProjectName },
    ...updates === void 0 ? {} : { updates }
  };
}
function resolveReplicaDestination(replica, primary, primaryProjectName) {
  if (!replica || typeof replica !== "object")
    throw new TypeError("Invalid upload replica");
  const updates = snapshotReplicaUpdates(replica.updates);
  const workspaceId = replica.workspaceId ?? primary.workspaceId;
  return resolveDestination({
    apiKey: replica.apiKey ?? primary.apiKey,
    apiUrl: replica.apiUrl ?? primary.apiUrl,
    projectName: replica.projectName ?? primary.projectName,
    ...workspaceId === void 0 ? {} : { workspaceId }
  }, primaryProjectName, updates);
}
function snapshotReplicaUpdates(value) {
  if (value === void 0)
    return void 0;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Replica updates must be an object");
  }
  let snapshot;
  try {
    snapshot = JSON.parse(JSON.stringify(value));
  } catch {
    throw new TypeError("Replica updates must be JSON serializable");
  }
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("Replica updates must be an object");
  }
  const updates = snapshot;
  for (const field2 of Object.keys(updates)) {
    if (UPLOAD_REPLICA_IDENTITY_UPDATE_FIELDS.has(field2)) {
      throw new TypeError("Replica updates cannot override run identity");
    }
    if (!UPLOAD_REPLICA_PATCH_UPDATE_FIELDS.has(field2)) {
      throw new TypeError("Unsupported replica update field");
    }
    if (field2 === "extra" && (updates[field2] === null || typeof updates[field2] !== "object" || Array.isArray(updates[field2]))) {
      throw new TypeError("Replica extra updates must be an object");
    }
  }
  return canonicalJsonObject(updates, "Replica updates");
}
function normalizeApiUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("An API endpoint is required for each upload destination");
  }
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError("Invalid upload API endpoint");
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:" || endpoint.username.length > 0 || endpoint.password.length > 0 || endpoint.search.length > 0 || endpoint.hash.length > 0) {
    throw new TypeError("Invalid upload API endpoint");
  }
  return endpoint.toString().replace(UPLOAD_API_URL_TRAILING_SLASH_PATTERN, "");
}
function normalizeRequiredText(value, name) {
  if (typeof value !== "string" || value.trim().length === 0 || UPLOAD_CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new TypeError(`Invalid upload ${name}`);
  }
  return value.trim();
}
function fingerprint(value) {
  return createHash4("sha256").update(value).digest("hex").slice(0, UPLOAD_FINGERPRINT_LENGTH);
}

// node_modules/.pnpm/@langchain+plugins-base@htt_162ae748324fb860f7b803d415a28ef5/node_modules/@langchain/plugins-base/dist/tracing/upload/identity.js
function resolveUploadDestinationFingerprint(options) {
  return resolveUploadDestinationIdentities(options).accountFingerprint;
}

// dist/src/tracing-engine-config.js
function validateProjectName(project) {
  if (!isValidBoundedText(project, CURSOR_ENGINE_WORKER_ARGUMENT_LIMITS.project)) {
    throw new Error("Shared trace worker project is invalid");
  }
}
function writerOptions(config, projectName = config.project) {
  return {
    destinations: [{ apiKey: config.apiKey, apiUrl: config.apiUrl, projectName }],
    ...config.replicas === void 0 ? {} : { replicas: uploadReplicas(config.replicas) },
    redact: config.redact,
    ...config.redactExtraRules === void 0 ? {} : {
      redactExtraRules: config.redactExtraRules.map((rule) => ({
        pattern: rule.pattern,
        ...rule.replace === void 0 ? {} : { replace: rule.replace }
      }))
    }
  };
}
function uploadReplicas(replicas) {
  return replicas.map((replica) => {
    if (Array.isArray(replica)) {
      const [projectName, updates] = replica;
      return {
        projectName,
        ...updates === void 0 ? {} : { updates }
      };
    }
    return {
      ...replica.apiKey === void 0 ? {} : { apiKey: replica.apiKey },
      ...replica.apiUrl === void 0 ? {} : { apiUrl: replica.apiUrl },
      ...replica.projectName === void 0 ? {} : { projectName: replica.projectName },
      ...replica.workspaceId === void 0 ? {} : { workspaceId: replica.workspaceId },
      ...replica.updates === void 0 ? {} : { updates: replica.updates }
    };
  });
}

// dist/src/turn-origin.js
function resolveTurnOriginRoute(origin, fallbackSessionId) {
  if (!origin)
    throw new Error(CURSOR_TURN_ORIGIN_ERRORS.unavailable);
  const metadataCwd = typeof origin.customMetadata?.cwd === "string" ? origin.customMetadata.cwd : void 0;
  const cwd = origin.cwd ?? metadataCwd;
  if (!cwd)
    throw new Error(CURSOR_TURN_ORIGIN_ERRORS.cwdUnavailable);
  if (!origin.destinationFingerprint) {
    throw new Error(CURSOR_TURN_ORIGIN_ERRORS.destinationUnavailable);
  }
  const routedConfig = loadConfig({ cwd, includeGitMetadata: false });
  const sessionId = origin.sessionId ?? fallbackSessionId;
  const destinationFingerprint = destinationFingerprintForConfig(routedConfig, origin.project);
  if (destinationFingerprint === void 0) {
    throw new Error(CURSOR_TURN_ORIGIN_ERRORS.destinationChanged);
  }
  if (origin.destinationFingerprint !== destinationFingerprint) {
    throw new Error(CURSOR_TURN_ORIGIN_ERRORS.destinationChanged);
  }
  return {
    config: routedConfig,
    cwd,
    sessionId,
    storageRoot: dirname5(routedConfig.stateFilePath),
    destinationFingerprint,
    origin
  };
}
function destinationFingerprintForConfig(config, projectName = config.project) {
  if (!config.apiKey && !config.replicas?.length)
    return void 0;
  validateProjectName(projectName);
  return resolveUploadDestinationFingerprint(writerOptions(config, projectName));
}

// dist/src/early-tool-capture.js
async function captureEarlyCursorToolSource(config, input, nowMs) {
  const state = loadState(config.stateFilePath);
  if (isKnownChildConversation(state, input.conversation_id))
    return void 0;
  const current = getTurnBuffer(state, input.conversation_id, input.generation_id);
  if (current?.tracingMode !== "full" && current?.tracingMode !== "metadata") {
    return void 0;
  }
  const next = input.hook_event_name === "postToolUse" ? reducePostToolUse(state, input, nowMs) : reducePostToolUseFailure(state, input, nowMs);
  const buffer = getTurnBuffer(next, input.conversation_id, input.generation_id);
  if (!buffer || !Number.isSafeInteger(buffer.turnNum))
    return void 0;
  const origin = buffer.origin;
  const { cwd, sessionId, storageRoot, destinationFingerprint } = resolveTurnOriginRoute(origin, input.session_id ?? input.conversation_id);
  return captureCursorNativeTurnSource({
    storageRoot,
    accountFingerprint: destinationFingerprint,
    sessionId,
    conversationId: input.conversation_id,
    sourceEventId: earlyToolSourceEventId(input.tool_use_id),
    turnNum: buffer.turnNum,
    buffer,
    cwd
  });
}
function earlyToolSourceEventId(toolUseId) {
  return `${CURSOR_EARLY_TOOL_SOURCE_EVENT_PREFIX}${createHash5("sha256").update(toolUseId).digest("hex")}`;
}
function isKnownChildConversation(state, conversationId) {
  return Object.entries(state).some(([parentId, conversation]) => parentId !== conversationId && allBuffers(conversation).some((turn) => turn.subagents.some((subagent) => subagent.childConversationId === conversationId)));
}
function allBuffers(conversation) {
  return [
    ...Object.values(conversation.turns),
    ...Object.values(conversation.pending ?? {}).map((entry) => entry.buffer)
  ];
}

// dist/src/hooks/post-tool-use.js
async function main() {
  const input = await readStdin();
  const config = initHook(input.workspace_roots?.[0]);
  if (!config)
    return;
  debug(`postToolUse ${input.tool_name} conv=${input.conversation_id} gen=${input.generation_id}`);
  const nowMs = Date.now();
  try {
    await captureEarlyCursorToolSource(config, input, nowMs);
  } catch (err) {
    error(`postToolUse early capture failed: ${err}`);
  }
  await atomicUpdateState(config.stateFilePath, (s) => reducePostToolUse(s, input, nowMs));
}
var finished = main().catch((err) => {
  try {
    error(`postToolUse hook error: ${err}`);
  } catch {
  }
  process.exit(0);
});
export {
  finished
};
