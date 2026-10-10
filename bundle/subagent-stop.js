#!/usr/bin/env node

// dist/src/constants.js
var DEFAULT_PROJECT = "cursor";
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

// node_modules/.pnpm/@langchain+plugins-base@htt_f5d2489d8a14349bc025e7cbb3c0797b/node_modules/@langchain/plugins-base/dist/settings/constants.js
var COMMON_BOOLEAN_SETTINGS = {
  enabled: { default: false, restrictive: false },
  defaultMuted: { default: false, restrictive: true }
};

// node_modules/.pnpm/@langchain+plugins-base@htt_f5d2489d8a14349bc025e7cbb3c0797b/node_modules/@langchain/plugins-base/dist/settings/common-config.js
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

// node_modules/.pnpm/@langchain+plugins-base@htt_f5d2489d8a14349bc025e7cbb3c0797b/node_modules/@langchain/plugins-base/dist/storage/file-lock.js
import { chmod, link, lstat, mkdir, readFile, readdir, rmdir, rename, unlink, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { dirname as dirname2, join as join2, resolve as resolve2 } from "node:path";

// node_modules/.pnpm/@langchain+plugins-base@htt_f5d2489d8a14349bc025e7cbb3c0797b/node_modules/@langchain/plugins-base/dist/storage/constants.js
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

// node_modules/.pnpm/@langchain+plugins-base@htt_f5d2489d8a14349bc025e7cbb3c0797b/node_modules/@langchain/plugins-base/dist/storage/errors.js
import { resolve } from "node:path";
var FileLockTimeoutError = class extends Error {
  constructor(filePath) {
    super(`${FILE_LOCK_TIMEOUT_MESSAGE}: ${resolve(filePath)}`);
    this.name = FILE_LOCK_TIMEOUT_ERROR_NAME;
  }
};

// node_modules/.pnpm/@langchain+plugins-base@htt_f5d2489d8a14349bc025e7cbb3c0797b/node_modules/@langchain/plugins-base/dist/storage/file-lock.js
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
      if (code !== FILE_LOCK_EXISTS_CODE && !FILE_LOCK_WINDOWS_DIRECTORY_CONTENTION_CODES.some((candidate) => candidate === code)) {
        throw error2;
      }
      let isDirectory = false;
      try {
        isDirectory = (await lstat(gatePath)).isDirectory();
      } catch (statError) {
        if (code === FILE_LOCK_EXISTS_CODE && statError.code === FILE_LOCK_MISSING_CODE) {
          await waitForNextScan(deadline, filePath);
          continue;
        }
        throw error2;
      }
      if (!isDirectory)
        throw error2;
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
function getConversationState(state, conversationId) {
  return ownEntry(state, conversationId) ?? { turns: {}, turn_count: 0, updated: "" };
}
var CONVERSATION_MAX_AGE_MS = 24 * 60 * 60 * 1e3;

// dist/src/utils/validation/record.js
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// dist/src/normalize.js
var SUBAGENT_PSEUDO_TOOLS = /* @__PURE__ */ new Set(["UpdateCurrentStep"]);
function parseSubagentTranscript(rows) {
  const toolCalls = [];
  let resultText;
  for (const row of rows) {
    if (!isRecord2(row) || row.role !== "assistant")
      continue;
    const message = isRecord2(row.message) ? row.message : void 0;
    const content = message?.content;
    if (!Array.isArray(content))
      continue;
    for (const part of content) {
      if (!isRecord2(part))
        continue;
      if (part.type === "tool_use" && typeof part.name === "string") {
        if (SUBAGENT_PSEUDO_TOOLS.has(part.name))
          continue;
        toolCalls.push({ name: part.name, input: isRecord2(part.input) ? part.input : {} });
      } else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        resultText = part.text;
      }
    }
  }
  return { toolCalls, resultText };
}

// dist/src/reducer.js
function touch(conv, nowMs = Date.now()) {
  conv.updated = new Date(nowMs).toISOString();
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
  const resolvedChild = resolved?.childConversationId ?? findChildConversation(next, parentConv, target.startMs, nowMs);
  const childConv = resolvedChild === parentConv ? void 0 : resolvedChild;
  const child = childConv ? ownEntry(next, childConv) : void 0;
  if (childConv && child) {
    target.childConversationId = childConv;
    target.tools = collectTools(child);
    if (Object.keys(child.pending ?? {}).length > 0) {
      next = { ...next, [childConv]: { ...child, turns: {} } };
    } else {
      const { [childConv]: _consumed, ...rest } = next;
      next = rest;
    }
  } else if (resolved?.toolCalls?.length) {
    const calls = resolved.toolCalls;
    target.childConversationId = resolved.childConversationId;
    target.tools = calls.map((c, i) => transcriptToolEvent(c, i, calls.length, target.startMs, nowMs));
  }
  touch(conv);
  return next;
}

// dist/src/subagent-transcript.js
import { readFileSync as readFileSync3, readdirSync, statSync as statSync3 } from "node:fs";
import { dirname as dirname4, join as join3, basename } from "node:path";
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
    if (!isRecord2(row) || row.role !== "user")
      continue;
    const content = isRecord2(row.message) ? row.message.content : void 0;
    if (!Array.isArray(content))
      continue;
    return content.filter((p) => isRecord2(p) && p.type === "text").map((p) => typeof p.text === "string" ? p.text : "").join("");
  }
  return "";
}
function resolveSubagentTranscript(parentTranscriptPath, task) {
  if (!parentTranscriptPath)
    return void 0;
  try {
    const dir = join3(dirname4(parentTranscriptPath), "subagents");
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0)
      return void 0;
    const candidates = files.map((f) => {
      const full = join3(dir, f);
      return { full, child: basename(f, ".jsonl"), mtime: statSync3(full).mtimeMs };
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

// dist/src/hooks/subagent-stop.js
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
  process.exit(0);
});
