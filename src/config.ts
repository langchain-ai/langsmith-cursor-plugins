/**
 * Configuration loading, per field (later wins): defaults → home root → user
 * .cursor → project root → project .cursor → environment. All common fields,
 * including the master switch and default mute, use environment-first precedence.
 */

import {
  COMMON_BOOLEAN_SETTINGS,
  mergeCommonConfig,
  readCommonConfigFile,
  toSdkReplicas,
} from "./shared-config.js";
import { userInfo } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { RunTreeConfig } from "langsmith";
import type { StringNodeRule } from "langsmith/anonymizer";
import { debug as logDebug, error as logError } from "./logger.js";
import { DEFAULT_PROJECT, DEFAULT_SWEEP_IDLE_MINUTES } from "./constants.js";
import { homedir } from "node:os";

/**
 * Plugin version, injected at build time by esbuild `define` (no runtime
 * package.json); env is the fallback. → `ls_integration_version`.
 */
declare const __LS_INTEGRATION_VERSION__: string;
export const LS_INTEGRATION_VERSION: string | undefined =
  typeof __LS_INTEGRATION_VERSION__ !== "undefined"
    ? __LS_INTEGRATION_VERSION__
    : process.env.LANGSMITH_CURSOR_INTEGRATION_VERSION || undefined;

/** Host used to build a canonical https `repository_url` from a parsed provider. */
const PROVIDER_HOSTS: Record<string, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
  devAzure: "dev.azure.com",
};

export interface Config {
  /** Master switch — tracing only runs when true. */
  enabled: boolean;
  /** Fallback for threads without an explicit override; independent of enabled. */
  defaultMuted: boolean;
  apiKey: string;
  apiUrl: string;
  project: string;
  debug: boolean;
  stateFilePath: string;
  replicas?: RunTreeConfig["replicas"];
  /** Identity / repo / user metadata attached to every run. */
  customMetadata?: Record<string, unknown>;
  /** Enrich turns with image/file attachment bytes from Cursor's DB (default on). */
  attachmentsEnabled: boolean;
  /** Recover the turn's system prompt from Cursor's DB (default on). */
  systemPromptEnabled: boolean;
  /** Override the Cursor state.vscdb path used for DB enrichment. */
  cursorDbPath?: string;
  /** Redact detected secrets from traced data before upload (default on). */
  redact: boolean;
  sweepIdleMinutes: number;
  /** Extra user-supplied redaction rules (environment or common file config). */
  redactExtraRules?: StringNodeRule[];
}

const DEFAULT_API_URL = "https://api.smith.langchain.com";

// ─── Primitive parsers ───────────────────────────────────────────────────────

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return undefined;
}

function parsePositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseJson<T = Record<string, unknown>>(value: unknown): T | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/** Type guard for a user redaction rule: { pattern: string, replace?: string }. */
function isRedactRule(rule: unknown): rule is StringNodeRule {
  if (typeof rule !== "object" || rule === null) return false;
  const r = rule as Record<string, unknown>;
  return (
    typeof r.pattern === "string" && (r.replace === undefined || typeof r.replace === "string")
  );
}

/** Parse a JSON array of { pattern, replace }; invalid rules are logged and skipped. */
function parseRedactExtraRules(value: unknown): StringNodeRule[] | undefined {
  const parsed = parseJson<unknown>(value);
  if (parsed === undefined) return undefined;
  if (!Array.isArray(parsed)) {
    logError("LANGSMITH_CURSOR_REDACT_EXTRA must be a JSON array of { pattern, replace }.");
    return undefined;
  }
  const valid: StringNodeRule[] = [];
  for (const rule of parsed) {
    if (!isRedactRule(rule)) {
      logError("Skipping invalid LANGSMITH_CURSOR_REDACT_EXTRA rule.");
      continue;
    }
    valid.push(rule);
  }
  // An explicit empty array clears file rules; malformed nonempty arrays still fall through.
  return parsed.length === 0 || valid.length > 0 ? valid : undefined;
}

// ─── Cursor extensions are validated independently of the common contract ─────

interface CursorExtensions {
  attachments?: boolean;
  system_prompt?: boolean;
  sweep_idle_minutes?: number;
  cursor_db_path?: string;
}

function readConfigFile(file: string) {
  const result = readCommonConfigFile(file);
  for (const diagnostic of result.diagnostics) logError(diagnostic);
  const extensions: CursorExtensions = {};
  const raw = result.raw;
  if (raw) {
    for (const field of ["attachments", "system_prompt"] as const) {
      if (!Object.hasOwn(raw, field)) continue;
      if (typeof raw[field] === "boolean") extensions[field] = raw[field];
      else logError(`Invalid Cursor config extension ${field}; ignoring field.`);
    }
    if (Object.hasOwn(raw, "sweep_idle_minutes")) {
      const minutes = raw.sweep_idle_minutes;
      if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0)
        extensions.sweep_idle_minutes = minutes;
      else logError("Invalid Cursor config extension sweep_idle_minutes; ignoring field.");
    }
    if (Object.hasOwn(raw, "cursor_db_path")) {
      if (typeof raw.cursor_db_path === "string") extensions.cursor_db_path = raw.cursor_db_path;
      else logError("Invalid Cursor config extension cursor_db_path; ignoring field.");
    }
  }
  return { common: result.common, extensions };
}

/** Default mute accepts only untrimmed true/false; other present values fail closed. */
function parseStrictBoolean(value: string): boolean | undefined {
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  return undefined;
}

const BOOLEAN_SETTINGS = {
  enabled: {
    env: "TRACE_TO_LANGSMITH",
    parse: parseBoolean,
    ...COMMON_BOOLEAN_SETTINGS.enabled,
  },
  defaultMuted: {
    env: "LANGSMITH_CURSOR_DEFAULT_MUTED",
    parse: parseStrictBoolean,
    ...COMMON_BOOLEAN_SETTINGS.defaultMuted,
  },
} as const;
type BooleanSetting = keyof typeof BOOLEAN_SETTINGS;

/** Environment parsers retain their historical behavior, separate from strict file booleans. */
function envBoolean(field: BooleanSetting): boolean | undefined {
  const setting = BOOLEAN_SETTINGS[field];
  const env = process.env[setting.env];
  if (env === undefined) return undefined;
  return setting.parse(env) ?? setting.restrictive;
}

/** Read LANGSMITH_CURSOR_<suffix>, falling back to LANGSMITH_<suffix>. */
function getEnv(suffix: string): string | undefined {
  return process.env[`LANGSMITH_CURSOR_${suffix}`] ?? process.env[`LANGSMITH_${suffix}`];
}

/** Legacy environment parser only: keep SDK tuples and existing snake/camel aliases. */
function normalizeReplicas(
  replicas: Array<Record<string, unknown>> | undefined,
): RunTreeConfig["replicas"] | undefined {
  if (!Array.isArray(replicas) || replicas.some((r) => !r || typeof r !== "object"))
    return undefined;
  return replicas.map((r) =>
    Array.isArray(r)
      ? r
      : {
          ...(r.api_url || r.apiUrl ? { apiUrl: (r.api_url ?? r.apiUrl) as string } : {}),
          ...(r.api_key || r.apiKey ? { apiKey: (r.api_key ?? r.apiKey) as string } : {}),
          ...(r.project || r.projectName
            ? { projectName: (r.project ?? r.projectName) as string }
            : {}),
          ...(r.updates ? { updates: r.updates as Record<string, unknown> } : {}),
        },
  ) as RunTreeConfig["replicas"];
}

// ─── Git repo metadata (ported from the Claude Code integration) ─────────────

const GIT_PROVIDERS_REGEX = {
  github: /[@/](?:github\.com)[:/](.+?)(?:\.git)?\s/,
  gitlab: /[@/](?:gitlab\.com)[:/](.+?)(?:\.git)?\s/,
  bitbucket: /[@/](?:bitbucket\.org)[:/](.+?)(?:\.git)?\s/,
  devAzure: /[@/](?:dev\.azure\.com)[:/](.+?)(?:\.git)?\s/,
};

export function parseRepoName(remoteUrl: string): { provider: string; name: string } | undefined {
  for (const [provider, regex] of Object.entries(GIT_PROVIDERS_REGEX)) {
    const match = remoteUrl.match(regex);
    if (match) return { provider, name: match[1] };
  }
  return undefined;
}

export function getRepoName(cwd: string): { provider: string; name: string } | undefined {
  try {
    const output = execSync("git remote -v", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const remotes: Array<{ name: string; url: string }> = [];
    for (const line of output.trim().split("\n").filter(Boolean)) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2 && line.includes("(fetch)")) {
        remotes.push({ name: parts[0], url: parts[1] });
      }
    }
    const origin = remotes.find((r) => r.name === "origin");
    if (origin) {
      const name = parseRepoName(origin.url + " ");
      if (name) return name;
    }
    for (const remote of remotes) {
      const name = parseRepoName(remote.url + " ");
      if (name) return name;
    }
  } catch {
    // Not a git repo or git unavailable — skip.
  }
  return undefined;
}

/** Current branch + commit sha → coding-agent-v1 git_branch / git_commit_sha. */
export function getGitInfo(cwd: string): { branch?: string; commit?: string } {
  const result: { branch?: string; commit?: string } = {};
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // "HEAD" means detached — no branch name available.
    if (branch && branch !== "HEAD") result.branch = branch;
  } catch {
    // Not a git repo / git unavailable — skip.
  }
  try {
    const commit = execSync("git rev-parse HEAD", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (commit) result.commit = commit;
  } catch {
    // Not a git repo / git unavailable — skip.
  }
  return result;
}

// ─── Main loader ─────────────────────────────────────────────────────────────

export function loadConfig(options?: { cwd?: string }): Config {
  const cwd = options?.cwd ?? process.env.CURSOR_PROJECT_DIR ?? process.cwd();

  const userRootFile = readConfigFile(join(homedir(), ".langsmith-plugins.json"));
  const globalFile = readConfigFile(join(homedir(), ".cursor", "langsmith.json"));
  const rootFile = readConfigFile(join(cwd, "langsmith-plugins.json"));
  const localFile = readConfigFile(join(cwd, ".cursor", "langsmith.json"));

  const envMetadata = parseJson(getEnv("METADATA"));
  const envReplicas = parseJson<Array<Record<string, unknown>>>(getEnv("RUNS_ENDPOINTS"));
  const envDebug = parseBoolean(getEnv("DEBUG"));

  const common = mergeCommonConfig(
    {
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
        redact: parseBoolean(getEnv("REDACT")),
      },
      defaults: { api_key: "", api_url: DEFAULT_API_URL, project: DEFAULT_PROJECT },
    },
    { envFirst: true },
  );
  const { enabled, defaultMuted, redact } = common;
  const apiKey = common.api_key!;
  const apiUrl = common.api_url!;
  const project = common.project!;
  const debug = envDebug ?? false;
  // File replicas are canonical and strict. Do not reparse legacy environment values as files.
  const replicas = normalizeReplicas(envReplicas) ?? toSdkReplicas(common.replicas);

  // Attachment enrichment defaults ON; opt out via config or LANGSMITH_CURSOR_ATTACHMENTS.
  const attachmentsEnabled =
    parseBoolean(getEnv("ATTACHMENTS")) ??
    localFile.extensions.attachments ??
    rootFile.extensions.attachments ??
    globalFile.extensions.attachments ??
    userRootFile.extensions.attachments ??
    true;
  // System-prompt enrichment defaults ON; opt out via config or LANGSMITH_CURSOR_SYSTEM_PROMPT.
  const systemPromptEnabled =
    parseBoolean(getEnv("SYSTEM_PROMPT")) ??
    localFile.extensions.system_prompt ??
    rootFile.extensions.system_prompt ??
    globalFile.extensions.system_prompt ??
    userRootFile.extensions.system_prompt ??
    true;
  const sweepIdleMinutes =
    parsePositiveNumber(getEnv("SWEEP_IDLE_MINUTES")) ??
    localFile.extensions.sweep_idle_minutes ??
    rootFile.extensions.sweep_idle_minutes ??
    globalFile.extensions.sweep_idle_minutes ??
    userRootFile.extensions.sweep_idle_minutes ??
    DEFAULT_SWEEP_IDLE_MINUTES;
  const cursorDbPath =
    getEnv("DB_PATH") ??
    localFile.extensions.cursor_db_path ??
    rootFile.extensions.cursor_db_path ??
    globalFile.extensions.cursor_db_path ??
    userRootFile.extensions.cursor_db_path;

  const redactExtraRules =
    parseRedactExtraRules(getEnv("REDACT_EXTRA")) ?? common.redact_extra_rules;

  const stateFilePath =
    process.env.LANGSMITH_CURSOR_STATE_FILE ?? join(homedir(), ".cursor", "langsmith-state.json");

  // coding-agent-v1 base metadata (later spreads win). Identity literals are
  // owned by codingAgentMetadata(), so they're not here.
  const baseMetadata: Record<string, unknown> = { cwd };
  if (LS_INTEGRATION_VERSION) baseMetadata.ls_integration_version = LS_INTEGRATION_VERSION;

  // Repo attribution: name + provider, and the canonical https repository_url.
  const repo = getRepoName(cwd);
  if (repo) {
    baseMetadata.repository_name = repo.name;
    baseMetadata.repository_provider = repo.provider;
    const host = PROVIDER_HOSTS[repo.provider];
    if (host) baseMetadata.repository_url = `https://${host}/${repo.name}`;
  }
  const git = getGitInfo(cwd);
  if (git.branch) baseMetadata.git_branch = git.branch;
  if (git.commit) baseMetadata.git_commit_sha = git.commit;

  // user_id is not exposed by Cursor's hooks; user_email is added per-turn in buildTurnRuns.
  baseMetadata.local_username = userInfo().username;

  // All file/environment metadata stays user-supplied, never builder-trusted provenance.
  const customMetadata = { ...baseMetadata, ...common.metadata };

  if (enabled && !apiKey && (!replicas || replicas.length === 0)) {
    logDebug("Config enabled but no API key / replicas resolved");
  }

  return {
    enabled,
    defaultMuted,
    apiKey,
    apiUrl,
    project,
    debug,
    stateFilePath,
    replicas,
    customMetadata,
    attachmentsEnabled,
    systemPromptEnabled,
    cursorDbPath,
    redact,
    redactExtraRules,
    sweepIdleMinutes,
  };
}
