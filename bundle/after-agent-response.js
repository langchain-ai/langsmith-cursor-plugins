#!/usr/bin/env node

// dist/src/constants.js
var DEFAULT_PROJECT = "cursor";
var DEFAULT_SWEEP_IDLE_MINUTES = 360;
var DEFAULT_API_URL = "https://api.smith.langchain.com";
var CURSOR_DIRECTORY_NAME = ".cursor";
var LEADING_BYTE_ORDER_MARKS = /^\uFEFF+/;
var MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
var MAX_LOG_BYTES = 5 * 1024 * 1024;
var CONVERSATION_MAX_AGE_MS = 24 * 60 * 60 * 1e3;

// dist/src/utils/stdin.js
function readStdin(stream = process.stdin) {
  return new Promise((resolve3, reject) => {
    let data = "";
    stream.setEncoding("utf-8");
    stream.on("data", (chunk) => data += chunk);
    stream.on("end", () => {
      try {
        resolve3(JSON.parse(data.replace(LEADING_BYTE_ORDER_MARKS, "")));
      } catch (err) {
        reject(new Error(`Failed to parse hook input: ${err}`));
      }
    });
    stream.on("error", reject);
  });
}

// node_modules/.pnpm/@langchain+plugins-base@https+++codeload.github.com+langchain-ai+langsmith-plugin-binar_f8fc53f66e47cd2e621b16652112af9c/node_modules/@langchain/plugins-base/dist/settings/constants.js
import { constants } from "node:fs";
var COMMON_BOOLEAN_SETTINGS = {
  enabled: { default: false, restrictive: false },
  defaultMuted: { default: false, restrictive: true }
};
var COMMON_CONFIG_FILE_NAME = "langsmith.json";
var COMMON_CONFIG_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
var COMMON_CONFIG_ROOT_FILE_NAME = "langsmith-plugins.json";
var COMMON_CONFIG_USER_ROOT_FILE_NAME = ".langsmith-plugins.json";

// node_modules/.pnpm/@langchain+plugins-base@https+++codeload.github.com+langchain-ai+langsmith-plugin-binar_f8fc53f66e47cd2e621b16652112af9c/node_modules/@langchain/plugins-base/dist/settings/common-config.js
import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  let fd;
  try {
    fd = openSync(path, COMMON_CONFIG_OPEN_FLAGS);
  } catch (error2) {
    if (error2.code === "ENOENT") {
      try {
        lstatSync(path);
      } catch (lstatError) {
        if (lstatError.code === "ENOENT") {
          return absent();
        }
      }
    }
    return invalid();
  }
  try {
    if (!fstatSync(fd).isFile())
      return invalid();
    return parseCommonConfig(JSON.parse(readFileSync(fd, "utf8")));
  } catch {
    return invalid();
  } finally {
    try {
      closeSync(fd);
    } catch {
    }
  }
}
function absent() {
  return { status: "absent", common: {}, diagnostics: [] };
}
function readCommonConfigFiles(options) {
  const { cwd, home, harnessDirectory } = options;
  return {
    harness: readCommonConfigFile(join(cwd, harnessDirectory, COMMON_CONFIG_FILE_NAME)),
    root: readCommonConfigFile(join(cwd, COMMON_CONFIG_ROOT_FILE_NAME)),
    user: home ? readCommonConfigFile(join(home, harnessDirectory, COMMON_CONFIG_FILE_NAME)) : absent(),
    userRoot: home ? readCommonConfigFile(join(home, COMMON_CONFIG_USER_ROOT_FILE_NAME)) : absent()
  };
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

// dist/src/config.js
import { homedir as homedir2, userInfo } from "node:os";
import { join as join2 } from "node:path";
import { execSync } from "node:child_process";

// dist/src/logger.js
import { appendFileSync, mkdirSync, statSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
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

// dist/src/utils/parse.js
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

// dist/src/config.js
var LS_INTEGRATION_VERSION = true ? "0.5.0" : process.env.LANGSMITH_CURSOR_INTEGRATION_VERSION || void 0;
var PROVIDER_HOSTS = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
  devAzure: "dev.azure.com"
};
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
function cursorExtensions(raw) {
  const extensions = {};
  if (!raw)
    return extensions;
  for (const field of ["attachments", "system_prompt"]) {
    if (!Object.hasOwn(raw, field))
      continue;
    if (typeof raw[field] === "boolean")
      extensions[field] = raw[field];
    else
      error(`Invalid Cursor config extension ${field}; ignoring field.`);
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
  return extensions;
}
function parseStrictBoolean(value) {
  if (value.toLowerCase() === "true")
    return true;
  if (value.toLowerCase() === "false")
    return false;
  return void 0;
}
function envBoolean({ name, parse, restrictive }) {
  const value = process.env[name];
  if (value === void 0)
    return void 0;
  return parse(value) ?? restrictive;
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
  const files = readCommonConfigFiles({
    cwd,
    home: homedir2(),
    harnessDirectory: CURSOR_DIRECTORY_NAME
  });
  for (const { diagnostics } of Object.values(files)) {
    for (const diagnostic of diagnostics)
      error(diagnostic);
  }
  const extensions = [files.harness, files.root, files.user, files.userRoot].map(({ raw }) => cursorExtensions(raw));
  const fromFiles = (field) => extensions.find((source) => source[field] !== void 0)?.[field];
  const envMetadata = parseJson(getEnv("METADATA"));
  const envReplicas = parseJson(getEnv("RUNS_ENDPOINTS"));
  const envDebug = parseBoolean(getEnv("DEBUG"));
  const common = mergeCommonConfig({
    harness: files.harness.common,
    root: files.root.common,
    user: files.user.common,
    userRoot: files.userRoot.common,
    env: {
      enabled: envBoolean({
        name: "TRACE_TO_LANGSMITH",
        parse: parseBoolean,
        restrictive: COMMON_BOOLEAN_SETTINGS.enabled.restrictive
      }),
      defaultMuted: envBoolean({
        name: "LANGSMITH_CURSOR_DEFAULT_MUTED",
        parse: parseStrictBoolean,
        restrictive: COMMON_BOOLEAN_SETTINGS.defaultMuted.restrictive
      }),
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
  const attachmentsEnabled = parseBoolean(getEnv("ATTACHMENTS")) ?? fromFiles("attachments") ?? true;
  const systemPromptEnabled = parseBoolean(getEnv("SYSTEM_PROMPT")) ?? fromFiles("system_prompt") ?? true;
  const sweepIdleMinutes = parsePositiveNumber(getEnv("SWEEP_IDLE_MINUTES")) ?? fromFiles("sweep_idle_minutes") ?? DEFAULT_SWEEP_IDLE_MINUTES;
  const cursorDbPath = getEnv("DB_PATH") ?? fromFiles("cursor_db_path");
  const redactExtraRules = parseRedactExtraRules(getEnv("REDACT_EXTRA")) ?? common.redact_extra_rules;
  const stateFilePath = process.env.LANGSMITH_CURSOR_STATE_FILE ?? join2(homedir2(), CURSOR_DIRECTORY_NAME, "langsmith-state.json");
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
    redactExtraRules,
    sweepIdleMinutes
  };
}

// dist/src/utils/hook-init.js
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

// node_modules/.pnpm/@langchain+plugins-base@https+++codeload.github.com+langchain-ai+langsmith-plugin-binar_f8fc53f66e47cd2e621b16652112af9c/node_modules/@langchain/plugins-base/dist/storage/file-lock.js
import { chmod, link, lstat as lstat2, mkdir as mkdir2, readFile as readFile2, readdir, rename as rename2, writeFile as writeFile2 } from "node:fs/promises";
import { performance as performance3 } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID as randomUUID2 } from "node:crypto";
import { dirname as dirname4, join as join4, resolve as resolve2 } from "node:path";

// node_modules/.pnpm/@langchain+plugins-base@https+++codeload.github.com+langchain-ai+langsmith-plugin-binar_f8fc53f66e47cd2e621b16652112af9c/node_modules/@langchain/plugins-base/dist/utils/constants.js
var FILE_MISSING_CODE = "ENOENT";
var PROCESS_MISSING_CODE = "ESRCH";
var PROCESS_CHECK_SIGNAL = 0;
var WINDOWS_PLATFORM = "win32";
var FILE_EXISTS_CODE = "EEXIST";
var PERMISSION_DENIED_CODE = "EPERM";
var FILE_ACCESS_DENIED_CODE = "EACCES";
var FILE_BUSY_CODE = "EBUSY";

// node_modules/.pnpm/@langchain+plugins-base@https+++codeload.github.com+langchain-ai+langsmith-plugin-binar_f8fc53f66e47cd2e621b16652112af9c/node_modules/@langchain/plugins-base/dist/storage/capture/constants.js
var CAPTURE_TURN_CEILING_MS = 7 * 24 * 60 * 60 * 1e3;

// node_modules/.pnpm/@langchain+plugins-base@https+++codeload.github.com+langchain-ai+langsmith-plugin-binar_f8fc53f66e47cd2e621b16652112af9c/node_modules/@langchain/plugins-base/dist/utils/validation/objects.js
function isPlainRecord(value) {
  return value !== null && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

// node_modules/.pnpm/@langchain+plugins-base@https+++codeload.github.com+langchain-ai+langsmith-plugin-binar_f8fc53f66e47cd2e621b16652112af9c/node_modules/@langchain/plugins-base/dist/storage/constants.js
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
var FILE_LOCK_RENAME_RETRY_TIMEOUT_MS = 100;
var FILE_LOCK_HEARTBEAT_MS = 500;
var FILE_LOCK_STALE_CLAIM_MS = 3e3;
var FILE_LOCK_TRY_CHOOSING_WAIT_MS = 1e3;
var FILE_LOCK_DIRECTORY_CONTENTION_CODES = [
  PERMISSION_DENIED_CODE,
  FILE_ACCESS_DENIED_CODE
];
var FILE_LOCK_BUSY_FILE_CODES = [
  ...FILE_LOCK_DIRECTORY_CONTENTION_CODES,
  FILE_BUSY_CODE
];
var FILE_LOCK_HEARTBEAT_WARNING = "Could not refresh a file lock claim:";
var FILE_LOCK_COMPATIBLE_ACQUIRE_CLEANUP_MESSAGE = "Could not release the legacy lock gate after shared lock acquisition failed";
var FILE_LOCK_COMPATIBLE_RELEASE_MESSAGE = "Could not release compatible file lock";
var FILE_LOCK_COMPATIBLE_GATE_CHANGED_MESSAGE = "Legacy file lock gate changed before release";
var FILE_LOCK_COMPATIBLE_OWNER_FILE = "owner";
var FILE_LOCK_COMPATIBLE_OWNER_MESSAGE = "Could not record the legacy file lock gate owner";
var FILE_LOCK_COMPATIBLE_OWNER_PID_PATTERN = /^[1-9]\d*$/u;
var FILE_LOCK_COMPATIBLE_ABANDONED_GATE_MS = 5e3;
var FILE_LOCK_COMPATIBLE_STALE_SUFFIX = ".stale";
var FILE_LOCK_GATE_CLEANUP_WARNING = "Could not remove a half-created lock folder:";
var FILE_LOCK_STALE_GATE_CLEANUP_WARNING = "Could not remove an old lock folder:";
var FILE_LOCK_WINDOWS_DENIED_RETRIES = 5;
var STORAGE_NOT_WRITABLE_ERROR_NAME = "StorageNotWritableError";
var STORAGE_NOT_WRITABLE_MESSAGE = "LangSmith can't write to its storage folder";
var STORAGE_NOT_WRITABLE_FIX = "Fix that folder's permissions so your user account can create files in it, and tracing will resume.";
var STORAGE_STALE_FILE_MAX_AGE_MS = 2 * 60 * 60 * 1e3;
var FILE_LOCK_LOST_MESSAGE = "The file lock was taken over before the write finished";
var STORAGE_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
var STORAGE_ENGINE_FILE_PATTERNS = [
  new RegExp(`^\\.${STORAGE_UUID}(\\.${STORAGE_UUID})?\\.tmp$`, "u"),
  new RegExp(`^wake-[0-9a-f]{64}\\.active\\.${STORAGE_UUID}(\\.attempt\\.[1-9]\\d*)?\\.json$`, "u"),
  /^wake-[0-9a-f]{64}\.launching$/u
];
var STORAGE_CLAIM_FILE = new RegExp(`^${STORAGE_UUID}\\.json$`, "u");

// node_modules/.pnpm/@langchain+plugins-base@https+++codeload.github.com+langchain-ai+langsmith-plugin-binar_f8fc53f66e47cd2e621b16652112af9c/node_modules/@langchain/plugins-base/dist/utils/errors.js
function describe(error2) {
  return error2 instanceof Error ? error2.message : String(error2);
}
function errorCode(error2) {
  return error2 !== null && typeof error2 === "object" && "code" in error2 && typeof error2.code === "string" ? error2.code : void 0;
}

// node_modules/.pnpm/@langchain+plugins-base@https+++codeload.github.com+langchain-ai+langsmith-plugin-binar_f8fc53f66e47cd2e621b16652112af9c/node_modules/@langchain/plugins-base/dist/storage/errors.js
import { resolve } from "node:path";
var FileLockTimeoutError = class extends Error {
  blockedPath;
  constructor(blockedPath) {
    super(`${FILE_LOCK_TIMEOUT_MESSAGE}: ${resolve(blockedPath)}`);
    this.name = FILE_LOCK_TIMEOUT_ERROR_NAME;
    this.blockedPath = resolve(blockedPath);
  }
};
var StorageNotWritableError = class extends Error {
  folder;
  code;
  constructor(folder, cause) {
    super(`${STORAGE_NOT_WRITABLE_MESSAGE} ${resolve(folder)}. ${STORAGE_NOT_WRITABLE_FIX}`, {
      cause
    });
    this.name = STORAGE_NOT_WRITABLE_ERROR_NAME;
    this.folder = resolve(folder);
    this.code = errorCode(cause);
  }
};

// node_modules/.pnpm/@langchain+plugins-base@https+++codeload.github.com+langchain-ai+langsmith-plugin-binar_f8fc53f66e47cd2e621b16652112af9c/node_modules/@langchain/plugins-base/dist/storage/file-lock-heartbeat.js
import { utimes } from "node:fs/promises";
var heartbeats = /* @__PURE__ */ new Map();
function startHeartbeat(path, id) {
  const timer = setInterval(() => {
    const now = /* @__PURE__ */ new Date();
    utimes(path, now, now).catch(warnUnlessMissing);
  }, FILE_LOCK_HEARTBEAT_MS);
  timer.unref();
  heartbeats.set(id, timer);
}
function stopHeartbeat(id) {
  clearInterval(heartbeats.get(id));
  heartbeats.delete(id);
}
function warnUnlessMissing(error2) {
  if (errorCode(error2) !== FILE_MISSING_CODE)
    console.warn(FILE_LOCK_HEARTBEAT_WARNING, describe(error2));
}

// node_modules/.pnpm/@langchain+plugins-base@https+++codeload.github.com+langchain-ai+langsmith-plugin-binar_f8fc53f66e47cd2e621b16652112af9c/node_modules/@langchain/plugins-base/dist/storage/legacy-gate.js
import { lstat, mkdir, readFile, rename, rmdir as rmdir2, writeFile } from "node:fs/promises";
import { performance as performance2 } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { dirname as dirname3, join as join3 } from "node:path";

// node_modules/.pnpm/@langchain+plugins-base@https+++codeload.github.com+langchain-ai+langsmith-plugin-binar_f8fc53f66e47cd2e621b16652112af9c/node_modules/@langchain/plugins-base/dist/storage/file-lock-support.js
import { unlink } from "node:fs/promises";
import { performance } from "node:perf_hooks";
function processIsAlive(pid) {
  try {
    process.kill(pid, PROCESS_CHECK_SIGNAL);
    return true;
  } catch (error2) {
    if (errorCode(error2) === PROCESS_MISSING_CODE)
      return false;
    return void 0;
  }
}
async function removeFile(filePath) {
  try {
    await unlink(filePath);
    return true;
  } catch (error2) {
    if (errorCode(error2) === FILE_MISSING_CODE)
      return true;
    return false;
  }
}
function isBusyFileError(error2) {
  return FILE_LOCK_BUSY_FILE_CODES.includes(errorCode(error2) ?? "");
}
function timeoutMs(options) {
  const value = options?.timeoutMs ?? FILE_LOCK_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(FILE_LOCK_INVALID_TIMEOUT_MESSAGE);
  return value;
}
function waitForNextScan(deadline, blockedPath) {
  const remaining = deadline - performance.now();
  if (remaining <= 0)
    return Promise.reject(new FileLockTimeoutError(blockedPath));
  return new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(FILE_LOCK_POLL_INTERVAL_MS, remaining)));
}

// node_modules/.pnpm/@langchain+plugins-base@https+++codeload.github.com+langchain-ai+langsmith-plugin-binar_f8fc53f66e47cd2e621b16652112af9c/node_modules/@langchain/plugins-base/dist/utils/files/cleanup.js
import { rmdir, unlink as unlink2 } from "node:fs/promises";
import { dirname as dirname2 } from "node:path";
async function removeDirectoryBestEffort(path, warning) {
  try {
    await rmdir(path);
  } catch (error2) {
    if (errorCode(error2) !== FILE_MISSING_CODE)
      console.warn(warning, describe(error2));
  }
}

// node_modules/.pnpm/@langchain+plugins-base@https+++codeload.github.com+langchain-ai+langsmith-plugin-binar_f8fc53f66e47cd2e621b16652112af9c/node_modules/@langchain/plugins-base/dist/storage/legacy-gate.js
async function createLegacyGate(gatePath) {
  await mkdir(gatePath, { mode: FILE_LOCK_DIRECTORY_MODE });
  const stat = await lstat(gatePath);
  if (!stat.isDirectory())
    throw new Error(FILE_LOCK_COMPATIBLE_GATE_CHANGED_MESSAGE);
  await recordLegacyGateOwner(gatePath);
  startHeartbeat(join3(gatePath, FILE_LOCK_COMPATIBLE_OWNER_FILE), gatePath);
  return { path: gatePath, dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}
function resetMissingPermission(attempt) {
  attempt.missingPermissionError = void 0;
  attempt.windowsDeniedRetries = 0;
}
async function waitOutContention(attempt, error2) {
  const { gatePath, filePath, deadline, tryAcquire } = attempt;
  const code = errorCode(error2);
  const permissionDenied = FILE_LOCK_DIRECTORY_CONTENTION_CODES.includes(code ?? "");
  if (code !== FILE_EXISTS_CODE && !permissionDenied)
    throw error2;
  let isContended = false;
  try {
    const gate = await lstat(gatePath);
    const isDirectory = gate.isDirectory();
    isContended = isDirectory || gate.isFile() && code === FILE_EXISTS_CODE;
    if (isContended && await legacyGateIsAbandoned(gatePath, isDirectory, gate.mtimeMs)) {
      if (!await reclaimLegacyGate(gatePath, filePath, tryAcquire))
        await waitForNextScan(deadline, gatePath);
      return;
    }
  } catch (statError) {
    if (errorCode(statError) === FILE_MISSING_CODE) {
      if (code === FILE_EXISTS_CODE) {
        resetMissingPermission(attempt);
        await waitForNextScan(deadline, gatePath);
        return;
      }
      if (permissionDenied) {
        const firstRetry = attempt.missingPermissionError === void 0;
        attempt.missingPermissionError = new StorageNotWritableError(dirname3(gatePath), error2);
        if (firstRetry)
          return;
        if (process.platform !== WINDOWS_PLATFORM || code !== PERMISSION_DENIED_CODE || attempt.windowsDeniedRetries >= FILE_LOCK_WINDOWS_DENIED_RETRIES)
          throw attempt.missingPermissionError;
        attempt.windowsDeniedRetries += 1;
        const denied = attempt.missingPermissionError;
        await waitForNextScan(deadline, gatePath).catch(() => Promise.reject(denied));
        return;
      }
    }
    throw error2;
  }
  if (!isContended)
    throw error2;
  resetMissingPermission(attempt);
  await waitForNextScan(deadline, gatePath);
}
async function acquireLegacyDirectoryGate(filePath, deadline, tryAcquire) {
  const gatePath = `${filePath}${FILE_LOCK_LEGACY_DIRECTORY_SUFFIX}`;
  await mkdir(dirname3(filePath), { recursive: true, mode: FILE_LOCK_DIRECTORY_MODE });
  const attempt = {
    gatePath,
    filePath,
    deadline,
    tryAcquire,
    windowsDeniedRetries: 0
  };
  for (; ; ) {
    if (performance2.now() >= deadline) {
      throw attempt.missingPermissionError ?? new FileLockTimeoutError(gatePath);
    }
    try {
      return await createLegacyGate(gatePath);
    } catch (error2) {
      await waitOutContention(attempt, error2);
    }
  }
}
async function releaseLegacyDirectoryGate(gate) {
  stopHeartbeat(gate.path);
  let stat;
  try {
    stat = await lstat(gate.path);
  } catch (error2) {
    if (errorCode(error2) === FILE_MISSING_CODE)
      return;
    throw error2;
  }
  if (!stat.isDirectory() || stat.dev !== gate.dev || stat.ino !== gate.ino || stat.birthtimeMs !== gate.birthtimeMs) {
    throw new Error(FILE_LOCK_COMPATIBLE_GATE_CHANGED_MESSAGE);
  }
  await removeFile(join3(gate.path, FILE_LOCK_COMPATIBLE_OWNER_FILE));
  await rmdir2(gate.path);
}
async function recordLegacyGateOwner(gatePath) {
  try {
    await writeFile(join3(gatePath, FILE_LOCK_COMPATIBLE_OWNER_FILE), String(process.pid), {
      flag: FILE_LOCK_EXCLUSIVE_FLAG,
      mode: FILE_LOCK_FILE_MODE
    });
  } catch (error2) {
    await removeDirectoryBestEffort(gatePath, FILE_LOCK_GATE_CLEANUP_WARNING);
    throw new Error(FILE_LOCK_COMPATIBLE_OWNER_MESSAGE, { cause: error2 });
  }
}
async function legacyGateIsAbandoned(gatePath, isDirectory, modifiedAtMs) {
  let contents;
  try {
    contents = await readFile(isDirectory ? join3(gatePath, FILE_LOCK_COMPATIBLE_OWNER_FILE) : gatePath, FILE_LOCK_ENCODING);
  } catch (error2) {
    if (errorCode(error2) !== FILE_MISSING_CODE)
      return false;
    contents = "";
  }
  const pid = FILE_LOCK_COMPATIBLE_OWNER_PID_PATTERN.test(contents.trim()) ? Number(contents.trim()) : void 0;
  if (pid !== void 0 && Number.isSafeInteger(pid) && pid > 0)
    return processIsAlive(pid) === false || isDirectory && await ownerHeartbeatStopped(gatePath);
  return !isDirectory && Date.now() - modifiedAtMs >= FILE_LOCK_COMPATIBLE_ABANDONED_GATE_MS;
}
async function ownerHeartbeatStopped(gatePath) {
  try {
    const owner = await lstat(join3(gatePath, FILE_LOCK_COMPATIBLE_OWNER_FILE));
    return Date.now() - owner.mtimeMs >= FILE_LOCK_STALE_CLAIM_MS;
  } catch {
    return false;
  }
}
async function reclaimLegacyGate(gatePath, filePath, tryAcquire) {
  const takeover = await tryAcquire(filePath);
  if (!takeover)
    return false;
  try {
    let gate;
    try {
      gate = await lstat(gatePath);
    } catch (error2) {
      if (errorCode(error2) === FILE_MISSING_CODE)
        return true;
      throw error2;
    }
    const isDirectory = gate.isDirectory();
    if (!await legacyGateIsAbandoned(gatePath, isDirectory, gate.mtimeMs))
      return false;
    const stalePath = `${gatePath}.${randomUUID()}${FILE_LOCK_COMPATIBLE_STALE_SUFFIX}`;
    try {
      await rename(gatePath, stalePath);
    } catch (error2) {
      if (isBusyFileError(error2))
        return false;
      throw error2;
    }
    if (!isDirectory) {
      await removeFile(stalePath);
      return true;
    }
    await removeFile(join3(stalePath, FILE_LOCK_COMPATIBLE_OWNER_FILE));
    await removeDirectoryBestEffort(stalePath, FILE_LOCK_STALE_GATE_CLEANUP_WARNING);
    return true;
  } finally {
    await takeover.release();
  }
}

// node_modules/.pnpm/@langchain+plugins-base@https+++codeload.github.com+langchain-ai+langsmith-plugin-binar_f8fc53f66e47cd2e621b16652112af9c/node_modules/@langchain/plugins-base/dist/storage/file-lock.js
function parseClaim(value, id) {
  if (!isPlainRecord(value))
    return void 0;
  if (value.version !== FILE_LOCK_CLAIM_VERSION || value.id !== id || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.choosing !== "boolean" || typeof value.ticket !== "number" || !Number.isSafeInteger(value.ticket) || value.ticket < FILE_LOCK_NEGATIVE_TICKET_LIMIT || (value.choosing ? value.ticket !== FILE_LOCK_UNSELECTED_TICKET : value.ticket === FILE_LOCK_UNSELECTED_TICKET)) {
    return void 0;
  }
  return value;
}
async function publishClaim(filePath, claim, create, deadline) {
  const temporaryPath = join4(dirname4(filePath), `${FILE_LOCK_TEMP_PREFIX}${claim.id}.${randomUUID2()}${FILE_LOCK_TEMP_SUFFIX}`);
  try {
    await writeFile2(temporaryPath, JSON.stringify(claim), {
      flag: FILE_LOCK_EXCLUSIVE_FLAG,
      mode: FILE_LOCK_FILE_MODE
    });
    if (create)
      await link(temporaryPath, filePath);
    else {
      const replacementDeadline = deadline ?? performance3.now() + FILE_LOCK_RENAME_RETRY_TIMEOUT_MS;
      for (; ; ) {
        try {
          await rename2(temporaryPath, filePath);
          break;
        } catch (error2) {
          if (errorCode(error2) !== PERMISSION_DENIED_CODE)
            throw error2;
          await waitForNextScan(replacementDeadline, dirname4(filePath));
        }
      }
    }
  } finally {
    await removeFile(temporaryPath);
  }
}
async function createClaim(claimDirectory) {
  for (; ; ) {
    const id = randomUUID2();
    const claim = {
      version: FILE_LOCK_CLAIM_VERSION,
      id,
      pid: process.pid,
      choosing: true,
      ticket: FILE_LOCK_UNSELECTED_TICKET
    };
    try {
      const path = join4(claimDirectory, `${id}${FILE_LOCK_CLAIM_EXTENSION}`);
      await publishClaim(path, claim, true);
      startHeartbeat(path, id);
      return claim;
    } catch (error2) {
      if (errorCode(error2) !== FILE_EXISTS_CODE)
        throw error2;
    }
  }
}
async function scanClaims(claimDirectory, ownPath) {
  const entries = await readdir(claimDirectory, { withFileTypes: true });
  const claims = [];
  const reference = ownPath === void 0 ? void 0 : await modifiedAt(ownPath);
  const abandoned = async (path) => {
    if (reference === void 0)
      return false;
    const modified = await modifiedAt(path);
    if (modified === void 0 || reference - modified < FILE_LOCK_STALE_CLAIM_MS)
      return false;
    return removeFile(path);
  };
  for (const entry of entries) {
    if (!entry.name.endsWith(FILE_LOCK_CLAIM_EXTENSION))
      continue;
    const id = entry.name.slice(0, -FILE_LOCK_CLAIM_EXTENSION.length);
    const path = join4(claimDirectory, entry.name);
    if (!entry.isFile())
      return { claims, blocked: true };
    let value;
    try {
      value = JSON.parse(await readFile2(path, FILE_LOCK_ENCODING));
    } catch (error2) {
      if (errorCode(error2) === FILE_MISSING_CODE)
        continue;
      if (await abandoned(path))
        continue;
      return {
        claims,
        blocked: true,
        transient: isBusyFileError(error2)
      };
    }
    const claim = parseClaim(value, id);
    if (!claim) {
      if (await abandoned(path))
        continue;
      return { claims, blocked: true };
    }
    const alive = processIsAlive(claim.pid);
    if (alive === false) {
      if (!await removeFile(path))
        return { claims, blocked: true };
      continue;
    }
    if (await abandoned(path))
      continue;
    if (alive === void 0)
      return { claims, blocked: true };
    claims.push(claim);
  }
  return { claims, blocked: false };
}
async function modifiedAt(path) {
  try {
    return (await lstat2(path)).mtimeMs;
  } catch (error2) {
    if (errorCode(error2) === FILE_MISSING_CODE)
      return void 0;
    throw error2;
  }
}
function claimPath(claimDirectory, id) {
  return join4(claimDirectory, `${id}${FILE_LOCK_CLAIM_EXTENSION}`);
}
function hasClaimState(claims, id, choosing, ticket) {
  const claim = claims.find((peer) => peer.id === id);
  return claim?.choosing === choosing && claim.ticket === ticket;
}
function makeHandle(claimDirectory, claim) {
  let releasePromise;
  return {
    async assertHeld() {
      if (await modifiedAt(claimPath(claimDirectory, claim.id)) === void 0)
        throw new Error(FILE_LOCK_LOST_MESSAGE);
    },
    release() {
      stopHeartbeat(claim.id);
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
  for (; ; ) {
    try {
      await assertSafeClaimDirectory(claimDirectory);
      await mkdir2(claimDirectory, { recursive: true, mode: FILE_LOCK_DIRECTORY_MODE });
      await assertSafeClaimDirectory(claimDirectory);
      await chmod(claimDirectory, FILE_LOCK_DIRECTORY_MODE);
      return { claimDirectory, claim: await createClaim(claimDirectory) };
    } catch (error2) {
      if (errorCode(error2) !== FILE_MISSING_CODE)
        throw error2;
    }
  }
}
async function assertSafeClaimDirectory(claimDirectory) {
  let stat;
  try {
    stat = await lstat2(claimDirectory);
  } catch (error2) {
    if (errorCode(error2) === FILE_MISSING_CODE)
      return;
    throw error2;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(FILE_LOCK_UNSAFE_DIRECTORY_MESSAGE);
}
function isStillBusy(attempt, scan) {
  return !attempt.waitForPeers && scan.blocked && scan.transient === true && performance3.now() < attempt.busyDeadline;
}
async function waitOrReleaseClaim(attempt) {
  if (!attempt.waitForPeers) {
    await makeHandle(attempt.claimDirectory, attempt.claim).release();
    return false;
  }
  await waitForNextScan(attempt.deadline, attempt.claimDirectory);
  return true;
}
async function observePeers(attempt, expectedChoosing, expectedTicket) {
  for (; ; ) {
    const scan = await scanClaims(attempt.claimDirectory, attempt.ownPath);
    if (isStillBusy(attempt, scan)) {
      await delay(FILE_LOCK_POLL_INTERVAL_MS);
      continue;
    }
    if (scan.blocked || !hasClaimState(scan.claims, attempt.claim.id, expectedChoosing, expectedTicket)) {
      if (!await waitOrReleaseClaim(attempt))
        return void 0;
      continue;
    }
    return scan.claims;
  }
}
async function takeTicket(attempt) {
  const { claim, claimDirectory, ownPath, waitForPeers } = attempt;
  const claims = await observePeers(attempt, true, FILE_LOCK_UNSELECTED_TICKET);
  if (claims === void 0)
    return void 0;
  if (!waitForPeers && claims.some((peer) => peer.id !== claim.id && !peer.choosing)) {
    await makeHandle(claimDirectory, claim).release();
    return void 0;
  }
  let maxTicket = FILE_LOCK_UNSELECTED_TICKET;
  for (const peer of claims)
    maxTicket = Math.max(maxTicket, peer.ticket);
  if (maxTicket >= Number.MAX_SAFE_INTEGER)
    throw new Error(FILE_LOCK_TICKET_LIMIT_MESSAGE);
  const ticketedClaim = { ...claim, choosing: false, ticket: maxTicket + 1 };
  await publishClaim(ownPath, ticketedClaim, false, waitForPeers ? attempt.deadline : attempt.busyDeadline);
  return ticketedClaim;
}
async function waitForTurn(attempt, ticketedClaim) {
  const { claim, claimDirectory, waitForPeers } = attempt;
  const choosingDeadline = performance3.now() + FILE_LOCK_TRY_CHOOSING_WAIT_MS;
  for (; ; ) {
    const claims = await observePeers(attempt, false, ticketedClaim.ticket);
    if (claims === void 0)
      return void 0;
    const peers = claims.filter((peer) => peer.id !== claim.id);
    if (!waitForPeers && !peers.some((peer) => !peer.choosing && precedes(peer, ticketedClaim)) && peers.some((peer) => peer.choosing) && performance3.now() < choosingDeadline) {
      await delay(FILE_LOCK_POLL_INTERVAL_MS);
      continue;
    }
    if (peers.some((peer) => precedes(peer, ticketedClaim))) {
      if (!await waitOrReleaseClaim(attempt))
        return void 0;
      continue;
    }
    if (waitForPeers && performance3.now() > attempt.deadline)
      throw new FileLockTimeoutError(claimDirectory);
    return { claimDirectory, claim: ticketedClaim };
  }
}
async function acquireClaim(filePath, waitForPeers, deadline) {
  const { claimDirectory, claim } = await beginClaim(filePath);
  const attempt = {
    filePath,
    claimDirectory,
    claim,
    ownPath: claimPath(claimDirectory, claim.id),
    waitForPeers,
    deadline,
    busyDeadline: performance3.now() + FILE_LOCK_TRY_CHOOSING_WAIT_MS
  };
  try {
    const ticketedClaim = await takeTicket(attempt);
    if (!ticketedClaim)
      return void 0;
    return await waitForTurn(attempt, ticketedClaim);
  } catch (error2) {
    await makeHandle(claimDirectory, claim).release();
    throw error2;
  }
}
async function tryAcquireFileLock(filePath) {
  const acquired = await acquireClaim(filePath, false, 0);
  if (!acquired)
    return void 0;
  return makeHandle(acquired.claimDirectory, acquired.claim);
}
async function acquireCompatibleDirectoryFileLock(filePath, options) {
  const resolvedPath = resolve2(filePath);
  const deadline = performance3.now() + timeoutMs(options);
  const gate = await acquireLegacyDirectoryGate(resolvedPath, deadline, tryAcquireFileLock);
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
    assertHeld: () => sharedHandle.assertHeld(),
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

// node_modules/.pnpm/@langchain+plugins-base@https+++codeload.github.com+langchain-ai+langsmith-plugin-binar_f8fc53f66e47cd2e621b16652112af9c/node_modules/@langchain/plugins-base/dist/storage/state-store.js
import { readFileSync as readFileSync3, renameSync as renameSync3 } from "node:fs";

// node_modules/.pnpm/@langchain+plugins-base@https+++codeload.github.com+langchain-ai+langsmith-plugin-binar_f8fc53f66e47cd2e621b16652112af9c/node_modules/@langchain/plugins-base/dist/utils/files/publish.js
import { closeSync as closeSync2, openSync as openSync2, renameSync as renameSync2, writeSync } from "node:fs";
import { randomUUID as randomUUID3 } from "node:crypto";
function publishByRename(path, contents, tempSuffix, mode) {
  const temp = `${path}.${randomUUID3()}${tempSuffix}`;
  const fd = openSync2(temp, "wx", mode);
  try {
    writeSync(fd, contents);
  } finally {
    closeSync2(fd);
  }
  renameSync2(temp, path);
}

// node_modules/.pnpm/@langchain+plugins-base@https+++codeload.github.com+langchain-ai+langsmith-plugin-binar_f8fc53f66e47cd2e621b16652112af9c/node_modules/@langchain/plugins-base/dist/storage/state-constants.js
var STATE_TEMP_SUFFIX = ".state.tmp";
var STATE_CORRUPT_SUFFIX = ".corrupt";
var STATE_FILE_ENCODING = "utf-8";
var STATE_LOCK_RELEASE_WARNING = "Could not release the shared state lock";
var STATE_LOCK_BUSY_WARNING = "Another process holds the state lock, so state updates in this hook are saved for the next lock holder";
var STATE_CORRUPT_WARNING = `State was unreadable; started over and kept the old file as ${STATE_CORRUPT_SUFFIX}`;
var STATE_LOCK_WAIT_MS = 1e3;
var STATE_LOCK_PROBE_MS = 200;
var STATE_LOCK_BUSY_MEMORY_MS = 3e4;
var PENDING_STATE_DIR_SUFFIX = ".pending";
var PENDING_STATE_FILE_SUFFIX = ".json";
var PENDING_STATE_TEMP_SUFFIX = ".pending.tmp";
var PENDING_STATE_ABANDONED_MS = 6e4;
var PENDING_STATE_TIME_WIDTH = 13;
var PENDING_STATE_SEQUENCE_WIDTH = 6;
var PENDING_STATE_WRITE_ATTEMPTS = 3;
var STATE_PRIVATE_DIR_MODE = 448;
var STATE_PRIVATE_FILE_MODE = 384;

// node_modules/.pnpm/@langchain+plugins-base@https+++codeload.github.com+langchain-ai+langsmith-plugin-binar_f8fc53f66e47cd2e621b16652112af9c/node_modules/@langchain/plugins-base/dist/storage/state-pending.js
import { mkdirSync as mkdirSync2, readdirSync, readFileSync as readFileSync2, rmdirSync, rmSync, statSync as statSync2 } from "node:fs";
import { join as join5 } from "node:path";
var sequence = 0;
var same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function diffValue(path, before, after, operations) {
  if (same(before, after))
    return;
  if (isPlainRecord(before) && isPlainRecord(after)) {
    for (const key of Object.keys(before)) {
      if (before[key] !== void 0 && after[key] === void 0) {
        operations.push({ path: [...path, key], unset: true });
      }
    }
    for (const [key, value] of Object.entries(after)) {
      if (value !== void 0)
        diffValue([...path, key], before[key], value, operations);
    }
  } else if (Array.isArray(before) && Array.isArray(after)) {
    const kept = new Set(after.map((item) => JSON.stringify(item)));
    const known = new Set(before.map((item) => JSON.stringify(item)));
    const add = after.filter((item) => !known.has(JSON.stringify(item)));
    const remove = before.filter((item) => !kept.has(JSON.stringify(item)));
    operations.push({ path, add, remove });
  } else {
    operations.push({ path, set: after });
  }
}
function diffState(before, after) {
  const patch = [];
  for (const session of Object.keys(before)) {
    if (!Object.hasOwn(after, session))
      patch.push({ session, removed: true });
  }
  for (const [session, next] of Object.entries(after)) {
    const operations = [];
    if (Object.hasOwn(before, session))
      diffValue([], before[session], next, operations);
    else
      operations.push({ path: [], set: next });
    if (operations.length > 0)
      patch.push({ session, operations });
  }
  return patch;
}
function applyOperation(root, operation) {
  const { path } = operation;
  if (path.length === 0)
    return operation.set;
  const [key, ...rest] = path;
  const node = isPlainRecord(root) ? { ...root } : {};
  if (rest.length > 0) {
    node[key] = applyOperation(node[key], { ...operation, path: rest });
  } else if (operation.unset) {
    delete node[key];
  } else if (operation.add || operation.remove) {
    node[key] = mergeList(node[key], operation);
  } else {
    node[key] = operation.set;
  }
  return node;
}
function mergeList(current, operation) {
  const removed = new Set((operation.remove ?? []).map((item) => JSON.stringify(item)));
  const list = (Array.isArray(current) ? current : []).filter((item) => !removed.has(JSON.stringify(item)));
  const present = new Set(list.map((item) => JSON.stringify(item)));
  for (const item of operation.add ?? []) {
    if (!present.has(JSON.stringify(item)))
      list.push(item);
  }
  return list;
}
function applyPatches(state, patches) {
  let result = state;
  for (const patch of patches) {
    for (const entry of patch) {
      if (entry.removed) {
        result = Object.fromEntries(Object.entries(result).filter(([id]) => id !== entry.session));
        continue;
      }
      let session = result[entry.session];
      for (const operation of entry.operations ?? [])
        session = applyOperation(session, operation);
      result = { ...result, [entry.session]: session };
    }
  }
  return result;
}
var pendingDirectory = (stateFilePath) => `${stateFilePath}${PENDING_STATE_DIR_SUFFIX}`;
function names(directory) {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}
function writePending(stateFilePath, patch) {
  if (patch.length === 0)
    return;
  const directory = pendingDirectory(stateFilePath);
  const time = String(Date.now()).padStart(PENDING_STATE_TIME_WIDTH, "0");
  const order = String(sequence++).padStart(PENDING_STATE_SEQUENCE_WIDTH, "0");
  const file = join5(directory, `${time}-${order}-${process.pid}${PENDING_STATE_FILE_SUFFIX}`);
  for (let attempt = 1; ; attempt++) {
    try {
      mkdirSync2(directory, { recursive: true, mode: STATE_PRIVATE_DIR_MODE });
      publishByRename(file, JSON.stringify(patch), PENDING_STATE_TEMP_SUFFIX, STATE_PRIVATE_FILE_MODE);
      return;
    } catch (error2) {
      if (attempt >= PENDING_STATE_WRITE_ATTEMPTS)
        throw error2;
    }
  }
}
function readPending(stateFilePath) {
  const directory = pendingDirectory(stateFilePath);
  const files = [];
  const patches = [];
  for (const name of names(directory).filter((n) => n.endsWith(PENDING_STATE_FILE_SUFFIX)).toSorted()) {
    const file = join5(directory, name);
    files.push(file);
    try {
      patches.push(JSON.parse(readFileSync2(file, "utf-8")));
    } catch {
      continue;
    }
  }
  return { files, patches };
}
function hasRecentPending(stateFilePath) {
  const directory = pendingDirectory(stateFilePath);
  return names(directory).some((name) => {
    try {
      return name.endsWith(PENDING_STATE_FILE_SUFFIX) && Date.now() - statSync2(join5(directory, name)).mtimeMs < STATE_LOCK_BUSY_MEMORY_MS;
    } catch {
      return false;
    }
  });
}
function removePending(stateFilePath, files) {
  const directory = pendingDirectory(stateFilePath);
  for (const file of files)
    rmSync(file, { force: true });
  for (const name of names(directory)) {
    if (name.endsWith(PENDING_STATE_FILE_SUFFIX))
      continue;
    const file = join5(directory, name);
    try {
      if (Date.now() - statSync2(file).mtimeMs > PENDING_STATE_ABANDONED_MS)
        rmSync(file, { force: true });
    } catch {
      continue;
    }
  }
  if (names(directory).length > 0)
    return;
  try {
    rmdirSync(directory);
  } catch {
    return;
  }
}

// node_modules/.pnpm/@langchain+plugins-base@https+++codeload.github.com+langchain-ai+langsmith-plugin-binar_f8fc53f66e47cd2e621b16652112af9c/node_modules/@langchain/plugins-base/dist/storage/state-store.js
function createStateStore(options) {
  const { path } = options;
  const warn2 = options.warn ?? console.warn;
  function read() {
    const { patches } = readPending(path);
    return applyPatches(readStateFile(path), patches);
  }
  async function update(fn) {
    const waitMs = hasRecentPending(path) ? STATE_LOCK_PROBE_MS : STATE_LOCK_WAIT_MS;
    const ran = await withStateFileLock(path, warn2, () => {
      const { files, patches } = readPending(path);
      const current = readStateFile(path, () => setAsideCorruptState(path, warn2));
      publishState(path, fn(applyPatches(current, patches)));
      removePending(path, files);
    }, waitMs);
    if (ran)
      return;
    const before = read();
    writePending(path, diffState(before, fn(before)));
  }
  return { read, update };
}
function readStateFile(path, onUnparseable) {
  let raw;
  try {
    raw = readFileSync3(path, STATE_FILE_ENCODING);
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return isPlainRecord(parsed) ? parsed : {};
  } catch {
    onUnparseable?.();
    return {};
  }
}
function setAsideCorruptState(path, warn2) {
  try {
    renameSync3(path, `${path}${STATE_CORRUPT_SUFFIX}`);
  } catch {
  }
  warn2(STATE_CORRUPT_WARNING);
}
function publishState(path, state) {
  publishByRename(path, JSON.stringify(state, null, 2), STATE_TEMP_SUFFIX, STATE_PRIVATE_FILE_MODE);
}
async function withStateFileLock(path, warn2, callback, waitMs) {
  let lock;
  try {
    lock = await acquireCompatibleDirectoryFileLock(path, { timeoutMs: waitMs });
  } catch (error2) {
    if (!(error2 instanceof FileLockTimeoutError))
      throw error2;
    warn2(STATE_LOCK_BUSY_WARNING);
    return false;
  }
  try {
    await callback();
  } finally {
    try {
      await lock.release();
    } catch (error2) {
      warn2(`${STATE_LOCK_RELEASE_WARNING}: ${error2}`);
    }
  }
  return true;
}

// dist/src/state.js
async function atomicUpdateState(stateFilePath, fn) {
  await stateStore(stateFilePath).update(fn);
}
function stateStore(stateFilePath) {
  return createStateStore({ path: stateFilePath, warn });
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

// dist/src/normalize.js
function preferModel(current, incoming) {
  if (incoming && incoming.toLowerCase() !== "default")
    return incoming;
  return current ?? incoming;
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
function reduceAfterAgentResponse(state, input, nowMs) {
  const conv = getConversationState(state, input.conversation_id);
  if (!acceptLateEvent(conv, input.conversation_id, input))
    return state;
  const turn = openTurn(conv, input.generation_id, nowMs);
  turn.finalText = input.text;
  turn.finalTextArrivedMs = nowMs;
  turn.model = preferModel(turn.model, input.model);
  turn.usage = {
    input_tokens: input.input_tokens,
    output_tokens: input.output_tokens,
    cache_read_tokens: input.cache_read_tokens,
    cache_write_tokens: input.cache_write_tokens
  };
  setOwnEntry(conv.turns, input.generation_id, turn);
  touch(conv);
  return { ...state, [input.conversation_id]: conv };
}

// dist/src/hooks/after-agent-response.js
async function main() {
  const input = await readStdin();
  const config = initHook(input.workspace_roots?.[0]);
  if (!config)
    return;
  debug(`afterAgentResponse conv=${input.conversation_id} gen=${input.generation_id}`);
  await atomicUpdateState(config.stateFilePath, (s) => reduceAfterAgentResponse(s, input, Date.now()));
}
main().catch((err) => {
  try {
    error(`afterAgentResponse hook error: ${err}`);
  } catch {
  }
  process.exit(0);
});
