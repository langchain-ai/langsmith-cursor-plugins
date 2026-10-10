/** Display name for the per-turn root (chain) run. */
export const TURN_RUN_NAME = "Cursor Turn";

/** Display name for the synthetic skill run, matching Claude Code's Skill tool. */
export const SKILL_RUN_NAME = "Skill";

/** Default tags attached to the root turn run. */
export const DEFAULT_TAGS = ["cursor", "coding-agent"];

/** Default LangSmith project name when none is configured. */
export const DEFAULT_PROJECT = "cursor";

export const CURSOR_INTEGRATION = "cursor";

export const CODING_AGENT_METADATA_OPTIONS = Symbol("cursor.metadataOptions");

export const CURSOR_ENGINE_WORKER_FLAG = "--cursor-engine-worker";
export const CURSOR_ENGINE_WORKER_ENTRY = "stop";
export const CURSOR_ENGINE_WORKER_MODE_SWEEP = "sweep";
export const CURSOR_ENGINE_WORKER_PRUNE = "prune";
export const CURSOR_ENGINE_WORKER_KEEP = "keep";
export const CURSOR_ENGINE_DEFAULT_MODEL = "default";
export const CURSOR_ENGINE_WORKER_ARGUMENT_LIMITS = {
  sessionId: 1024,
  cwd: 4096,
  project: 512,
  callerConversationId: 1024,
} as const;

export const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export const CURSOR_RUN_POST_EVENT_KIND = "run-post";
export const CURSOR_RUN_PATCH_EVENT_KIND = "run-patch";
export const CURSOR_TURN_SOURCE_DIRECTORY = "cursor-turn-sources-v1";
export const CURSOR_TURN_ROUTE_DIRECTORY = "cursor-turn-routes-v1";
export const CURSOR_RECONSTRUCTION_DIRECTORY = "reconstruction-v1";
export const CURSOR_TURN_SOURCE_EVENT_KIND = "cursor-turn-source-v1";
export const CURSOR_TURN_ROUTE_EVENT_KIND = "cursor-turn-route-v1";
export const CURSOR_STOP_SOURCE_EVENT_ID = "stop";
export const CURSOR_EARLY_TOOL_SOURCE_EVENT_PREFIX = "early-tool-";
export const CURSOR_STOP_RECONSTRUCTION_EVENT_KIND = "stop-reconstruction";
export const CURSOR_NATIVE_TURN_SOURCE_VERSION = 1;
export const CURSOR_NATIVE_TURN_ROUTE_VERSION = 1;
export const CURSOR_TURN_SOURCE_EVENT_ID_MAX_LENGTH = 1024;
export const CURSOR_TURN_ORIGIN_ERRORS = {
  unavailable: "Cursor tracing origin provenance is unavailable",
  cwdUnavailable: "Cursor tracing cwd provenance is unavailable",
  destinationUnavailable: "Cursor tracing destination provenance is unavailable",
  destinationChanged: "Cursor tracing destination changed since the turn started",
} as const;
export const CURSOR_NATIVE_SOURCE_ERRORS = {
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
  sourceWriteFailure: "Could not persist Cursor turn source: ",
} as const;
export const CURSOR_RECONSTRUCTION_ERRORS = {
  queueFailure: "Could not queue Cursor turn reconstruction: ",
} as const;
export const CURSOR_RECONSTRUCTION_PATCH_FIELDS = [
  "inputs",
  "outputs",
  "end_time",
  "error",
] as const;

export const CURSOR_ENGINE_NODE_SCRIPT = /\.(?:c|m)?js$|\.ts$/;

/** Read tools only, so a glob or grep naming SKILL.md is not counted as an invocation. */
export const READ_TOOLS = new Set(["read_file_v2", "ReadFile", "Read"]);

export const DEFAULT_SWEEP_IDLE_MINUTES = 360;

// ─── Git repo metadata (ported from the Claude Code integration) ─────────────

export const GIT_PROVIDERS_REGEX = {
  github: /[@/](?:github\.com)[:/](.+?)(?:\.git)?\s/,
  gitlab: /[@/](?:gitlab\.com)[:/](.+?)(?:\.git)?\s/,
  bitbucket: /[@/](?:bitbucket\.org)[:/](.+?)(?:\.git)?\s/,
  devAzure: /[@/](?:dev\.azure\.com)[:/](.+?)(?:\.git)?\s/,
};

/** Host used to build a canonical https `repository_url` from a parsed provider. */
export const PROVIDER_HOSTS: Record<string, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
  devAzure: "dev.azure.com",
};

export const MAX_UPLOAD_ATTEMPTS = 3;

/** Cursor hook event → the name the standalone binary is invoked with for it. */
export const BINARY_HOOK_EVENTS = {
  beforeSubmitPrompt: "before-submit-prompt",
  afterAgentResponse: "after-agent-response",
  postToolUse: "post-tool-use",
  postToolUseFailure: "post-tool-use-failure",
  subagentStart: "subagent-start",
  subagentStop: "subagent-stop",
  stop: "stop",
  sessionStart: "session-start",
} as const;

export const PLUGIN_BINARY_DIRECTORY_NAME = "binary";

export const PLUGIN_LAUNCHER_NAME = "langsmith-tracing.cmd";

export const PLUGIN_ROOT_PLACEHOLDER = "${CURSOR_PLUGIN_ROOT}";

export const LEADING_BYTE_ORDER_MARKS = /^\uFEFF+/;
