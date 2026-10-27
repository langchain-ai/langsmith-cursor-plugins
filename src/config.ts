/**
 * Configuration loading, per field (later wins): defaults → home root → user
 * .cursor → project root → project .cursor → environment. All common fields,
 * including the master switch and default mute, use environment-first precedence.
 */

import { sdkSetting } from "@langchain/plugins-base/auth";
import {
  COMMON_BOOLEAN_SETTINGS,
  lockPluginFields,
  mergeCommonConfig,
  readCommonConfigFiles,
  toSdkReplicas,
  type CommonRedactRule,
} from "@langchain/plugins-base/settings";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { LangSmithUploadReplicaConfig } from "@langchain/plugins-base/tracing/upload";
import { error as logError } from "./logger.js";
import {
  AGENT_ID_ENV_KEY,
  CURSOR_DIRECTORY_NAME,
  DEFAULT_API_URL,
  DEFAULT_PROJECT,
  DEFAULT_SWEEP_IDLE_MINUTES,
  MANAGED_PLUGIN_FIELDS,
  STATE_FILE_NAME,
} from "./constants.js";
import type { Config, CursorExtensions, EnvBooleanOptions } from "./models/config.js";
import { parseBoolean, parseJson, parsePositiveNumber } from "./utils/parse.js";

/**
 * Plugin version, injected at build time by esbuild `define` (no runtime
 * package.json); env is the fallback. → `ls_integration_version`.
 */
declare const __LS_INTEGRATION_VERSION__: string;
export const LS_INTEGRATION_VERSION: string | undefined =
  typeof __LS_INTEGRATION_VERSION__ !== "undefined"
    ? __LS_INTEGRATION_VERSION__
    : process.env.LANGSMITH_CURSOR_INTEGRATION_VERSION || undefined;

/** Type guard for a user redaction rule: { pattern: string, replace?: string }. */
function isRedactRule(rule: unknown): rule is CommonRedactRule {
  if (typeof rule !== "object" || rule === null) return false;
  const r = rule as Record<string, unknown>;
  return (
    typeof r.pattern === "string" && (r.replace === undefined || typeof r.replace === "string")
  );
}

/** Parse a JSON array of { pattern, replace }; invalid rules are logged and skipped. */
function parseRedactExtraRules(value: unknown): CommonRedactRule[] | undefined {
  const parsed = parseJson<unknown>(value);
  if (parsed === undefined) return undefined;
  if (!Array.isArray(parsed)) {
    logError("LANGSMITH_CURSOR_REDACT_EXTRA must be a JSON array of { pattern, replace }.");
    return undefined;
  }
  const valid: CommonRedactRule[] = [];
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

function cursorExtensions(raw: Record<string, unknown> | undefined): CursorExtensions {
  const extensions: CursorExtensions = {};
  if (!raw) return extensions;
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
  return extensions;
}

/** Default mute accepts only untrimmed true/false; other present values fail closed. */
function parseStrictBoolean(value: string): boolean | undefined {
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  return undefined;
}

/** Environment parsers retain their historical behavior, separate from strict file booleans. */
function envBoolean({ name, parse, restrictive }: EnvBooleanOptions): boolean | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  return parse(value) ?? restrictive;
}

/** Read LANGSMITH_CURSOR_<suffix>, falling back to LANGSMITH_<suffix>. */
function getEnv(suffix: string): string | undefined {
  return process.env[`LANGSMITH_CURSOR_${suffix}`] ?? process.env[`LANGSMITH_${suffix}`];
}

/** Legacy environment parser only: accept SDK tuples and the existing snake/camel aliases. */
function normalizeReplicas(
  replicas: Array<Record<string, unknown>> | undefined,
): LangSmithUploadReplicaConfig[] | undefined {
  if (!Array.isArray(replicas) || replicas.some((r) => !r || typeof r !== "object"))
    return undefined;
  return replicas.map((r) =>
    Array.isArray(r)
      ? { projectName: r[0] as string, updates: r[1] as Record<string, unknown> }
      : {
          ...(r.api_url || r.apiUrl ? { apiUrl: (r.api_url ?? r.apiUrl) as string } : {}),
          ...(sdkSetting(r.api_key ?? r.apiKey)
            ? { apiKey: (r.api_key ?? r.apiKey) as string }
            : {}),
          ...(r.project || r.projectName
            ? { projectName: (r.project ?? r.projectName) as string }
            : {}),
          ...(r.updates ? { updates: r.updates as Record<string, unknown> } : {}),
        },
  );
}

// ─── Main loader ─────────────────────────────────────────────────────────────

export function loadConfig(options?: { cwd?: string }): Config {
  const cwd = options?.cwd ?? process.env.CURSOR_PROJECT_DIR ?? process.cwd();

  const files = readCommonConfigFiles({
    cwd,
    home: homedir(),
    harnessDirectory: CURSOR_DIRECTORY_NAME,
  });
  for (const { diagnostics } of Object.values(files)) {
    for (const diagnostic of diagnostics) logError(diagnostic);
  }
  const extensions = [files.harness, files.root, files.user, files.userRoot].map(({ raw }) =>
    cursorExtensions(raw),
  );
  const fromFiles = <K extends keyof CursorExtensions>(field: K) =>
    extensions.find((source) => source[field] !== undefined)?.[field];
  const managedExtensions = cursorExtensions(
    lockPluginFields(files.managed, MANAGED_PLUGIN_FIELDS),
  );

  const envMetadata = parseJson(getEnv("METADATA"));
  const envReplicas = parseJson<Array<Record<string, unknown>>>(getEnv("RUNS_ENDPOINTS"));
  const envDebug = parseBoolean(getEnv("DEBUG"));

  const common = mergeCommonConfig(
    {
      managed: files.managed,
      harness: files.harness.common,
      root: files.root.common,
      user: files.user.common,
      userRoot: files.userRoot.common,
      env: {
        enabled: envBoolean({
          name: "TRACE_TO_LANGSMITH",
          parse: parseBoolean,
          restrictive: COMMON_BOOLEAN_SETTINGS.enabled.restrictive,
        }),
        defaultMuted: envBoolean({
          name: "LANGSMITH_CURSOR_DEFAULT_MUTED",
          parse: parseStrictBoolean,
          restrictive: COMMON_BOOLEAN_SETTINGS.defaultMuted.restrictive,
        }),
        api_key: process.env.LANGSMITH_CURSOR_API_KEY,
        api_url: getEnv("ENDPOINT"),
        project: getEnv("PROJECT"),
        agent_id: process.env[AGENT_ID_ENV_KEY],
        metadata: envMetadata,
        redact: parseBoolean(getEnv("REDACT")),
        redact_extra_rules: parseRedactExtraRules(getEnv("REDACT_EXTRA")),
        strict_auth: parseBoolean(getEnv("STRICT_AUTH")),
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
  const replicas = common.locked.includes("replicas")
    ? toSdkReplicas(common.replicas)
    : (normalizeReplicas(envReplicas) ?? toSdkReplicas(common.replicas));

  // Attachment and system-prompt enrichment default ON; opt out via config or the environment.
  const attachmentsEnabled =
    managedExtensions.attachments ??
    parseBoolean(getEnv("ATTACHMENTS")) ??
    fromFiles("attachments") ??
    true;
  const systemPromptEnabled =
    managedExtensions.system_prompt ??
    parseBoolean(getEnv("SYSTEM_PROMPT")) ??
    fromFiles("system_prompt") ??
    true;
  const sweepIdleMinutes =
    parsePositiveNumber(getEnv("SWEEP_IDLE_MINUTES")) ??
    fromFiles("sweep_idle_minutes") ??
    DEFAULT_SWEEP_IDLE_MINUTES;
  const cursorDbPath = getEnv("DB_PATH") ?? fromFiles("cursor_db_path");

  const stateFilePath =
    process.env.LANGSMITH_CURSOR_STATE_FILE ??
    join(homedir(), CURSOR_DIRECTORY_NAME, STATE_FILE_NAME);

  // coding-agent-v1 base metadata (later spreads win). Identity literals are
  // owned by codingAgentMetadata(), so they're not here.
  const baseMetadata: Record<string, unknown> = { cwd };
  if (LS_INTEGRATION_VERSION) baseMetadata.ls_integration_version = LS_INTEGRATION_VERSION;

  // user_id is not exposed by Cursor's hooks; user_email is added per-turn in buildTurnRuns.
  baseMetadata.local_username = userInfo().username;

  // All file/environment metadata stays user-supplied, never builder-trusted provenance.
  const customMetadata = { ...baseMetadata, ...common.metadata };

  return {
    enabled,
    defaultMuted,
    apiKey,
    apiUrl,
    ...(common.profile === undefined ? {} : { profile: common.profile }),
    ...(common.workspace_id === undefined ? {} : { workspaceId: common.workspace_id }),
    ...(common.agent_id === undefined ? {} : { agentId: common.agent_id }),
    project,
    debug,
    stateFilePath,
    replicas,
    customMetadata,
    attachmentsEnabled,
    systemPromptEnabled,
    cursorDbPath,
    redact,
    redactExtraRules: common.redact_extra_rules,
    sweepIdleMinutes,
    cwd,
    locked: common.locked,
    apiUrlIsDefault: common.defaulted.includes("api_url"),
    strictAuth: common.strict_auth === true,
    ...(common.managedConfigProblem === undefined
      ? {}
      : { managedConfigProblem: common.managedConfigProblem }),
  };
}
