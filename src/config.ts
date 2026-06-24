/**
 * Configuration loading. Cascade (later wins): defaults → global file → local
 * file → environment (LANGSMITH_CURSOR_* / LANGSMITH_*).
 */

import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { RunTreeConfig } from "langsmith";
import { debug as logDebug } from "./logger.js";
import { DEFAULT_PROJECT } from "./constants.js";

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
  /** Render true interleaved per-step fidelity from Cursor's DB protobuf (default on). */
  stepFidelityEnabled: boolean;
  /** Override the Cursor state.vscdb path used for DB enrichment. */
  cursorDbPath?: string;
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

function parseJson<T = Record<string, unknown>>(value: unknown): T | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

// ─── Config file shape (snake_case on disk) ──────────────────────────────────

interface FileConfig {
  enabled?: boolean;
  api_key?: string;
  api_url?: string;
  project?: string;
  metadata?: Record<string, unknown>;
  replicas?: Array<Record<string, unknown>>;
  attachments?: boolean;
  system_prompt?: boolean;
  step_fidelity?: boolean;
  cursor_db_path?: string;
}

function readConfigFile(file: string): FileConfig | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as FileConfig;
  } catch {
    return undefined;
  }
}

/** Read LANGSMITH_CURSOR_<suffix>, falling back to LANGSMITH_<suffix>. */
function getEnv(suffix: string): string | undefined {
  return process.env[`LANGSMITH_CURSOR_${suffix}`] ?? process.env[`LANGSMITH_${suffix}`];
}

/** Normalize a snake_case or camelCase replica entry to the LangSmith SDK shape. */
function normalizeReplicas(
  replicas: Array<Record<string, unknown>> | undefined,
): RunTreeConfig["replicas"] | undefined {
  if (!Array.isArray(replicas)) return undefined;
  return replicas.map((r) => ({
    ...(r.api_url || r.apiUrl ? { apiUrl: (r.api_url ?? r.apiUrl) as string } : {}),
    ...(r.api_key || r.apiKey ? { apiKey: (r.api_key ?? r.apiKey) as string } : {}),
    ...(r.project || r.projectName ? { projectName: (r.project ?? r.projectName) as string } : {}),
    ...(r.updates ? { updates: r.updates as Record<string, unknown> } : {}),
  })) as RunTreeConfig["replicas"];
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
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const cwd = options?.cwd ?? process.cwd();

  const globalFile = readConfigFile(join(home, ".cursor", "langsmith.json"));
  const localFile = readConfigFile(join(cwd, ".cursor", "langsmith.json"));

  const envEnabled = parseBoolean(process.env.TRACE_TO_LANGSMITH);
  const envMetadata = parseJson(getEnv("METADATA"));
  const envReplicas = parseJson<Array<Record<string, unknown>>>(getEnv("RUNS_ENDPOINTS"));
  const envDebug = parseBoolean(getEnv("DEBUG"));

  // Merge file layers then env (env wins).
  const enabled = envEnabled ?? localFile?.enabled ?? globalFile?.enabled ?? false;
  const apiKey = getEnv("API_KEY") ?? localFile?.api_key ?? globalFile?.api_key ?? "";
  const apiUrl = getEnv("ENDPOINT") ?? localFile?.api_url ?? globalFile?.api_url ?? DEFAULT_API_URL;
  const project = getEnv("PROJECT") ?? localFile?.project ?? globalFile?.project ?? DEFAULT_PROJECT;
  const debug = envDebug ?? false;

  const replicas = normalizeReplicas(envReplicas ?? localFile?.replicas ?? globalFile?.replicas);

  // Attachment enrichment defaults ON; opt out via config or LANGSMITH_CURSOR_ATTACHMENTS.
  const attachmentsEnabled =
    parseBoolean(getEnv("ATTACHMENTS")) ??
    localFile?.attachments ??
    globalFile?.attachments ??
    true;
  // System-prompt enrichment defaults ON; opt out via config or LANGSMITH_CURSOR_SYSTEM_PROMPT.
  const systemPromptEnabled =
    parseBoolean(getEnv("SYSTEM_PROMPT")) ??
    localFile?.system_prompt ??
    globalFile?.system_prompt ??
    true;
  // Step-fidelity enrichment defaults ON; opt out via config or LANGSMITH_CURSOR_STEP_FIDELITY.
  const stepFidelityEnabled =
    parseBoolean(getEnv("STEP_FIDELITY")) ??
    localFile?.step_fidelity ??
    globalFile?.step_fidelity ??
    true;
  const cursorDbPath = getEnv("DB_PATH") ?? localFile?.cursor_db_path ?? globalFile?.cursor_db_path;

  const stateFilePath =
    process.env.LANGSMITH_CURSOR_STATE_FILE ?? join(home, ".cursor", "langsmith-state.json");

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

  const fileMetadata = { ...globalFile?.metadata, ...localFile?.metadata };
  const customMetadata = { ...baseMetadata, ...fileMetadata, ...envMetadata };

  if (enabled && !apiKey && (!replicas || replicas.length === 0)) {
    logDebug("Config enabled but no API key / replicas resolved");
  }

  return {
    enabled,
    apiKey,
    apiUrl,
    project,
    debug,
    stateFilePath,
    replicas,
    customMetadata,
    attachmentsEnabled,
    systemPromptEnabled,
    stepFidelityEnabled,
    cursorDbPath,
  };
}
