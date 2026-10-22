/** Display name for the per-turn root (chain) run. */
export const TURN_RUN_NAME = "Cursor Turn";

/** Display name for the synthetic skill run, matching Claude Code's Skill tool. */
export const SKILL_RUN_NAME = "Skill";

/** Default tags attached to the root turn run. */
export const DEFAULT_TAGS = ["cursor", "coding-agent"];

/** Default LangSmith project name when none is configured. */
export const DEFAULT_PROJECT = "cursor";

export const DEFAULT_SWEEP_IDLE_MINUTES = 360;

export const NOTICE_PLUGIN = "cursor";

export const NOTICE_COOLDOWN_OFF = "off";

export const NOTICE_KINDS = { managed: "managed" };

export const MUTE_LOCKED_MESSAGE = "Thread tracing stays muted because an admin locked muting on.";

export const DEFAULT_API_URL = "https://api.smith.langchain.com";

export const CURSOR_DIRECTORY_NAME = ".cursor";

export const MANAGED_PLUGIN_FIELDS = {
  lockable: ["attachments", "system_prompt"],
  unlockable: ["sweep_idle_minutes", "cursor_db_path"],
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

export const LEADING_BYTE_ORDER_MARKS = /^\uFEFF+/;

export const LS_INTEGRATION = "cursor";

/** Read tools only, so a glob or grep naming SKILL.md is not counted as an invocation. */
export const SKILL_READ_TOOLS = new Set(["read_file_v2", "ReadFile", "Read"]);

export const PATH_SEPARATOR = /[/\\]/;

/** Skip attachments larger than this (raw bytes) — base64 inflates ~33% on top. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

export const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB

export const CONVERSATION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export const WHITESPACE_RUN = /\s+/g;

/** Reasoning-effort / thinking suffixes Cursor appends to model labels. */
export const MODEL_SUFFIXES = new Set([
  "thinking",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const PROVIDER_PREFIX = /^[a-z]+\//;

export const CLAUDE_VERSIONED_MODEL = /^claude-(\d+)\.(\d+)-(sonnet|opus|haiku)$/;

export const OPENAI_MODEL_PREFIX = /^(gpt|o\d)/;

export const CURSOR_VENDOR_PREFIX = /^cursor-/i;

/** MCP tool names arrive namespaced as "MCP:<tool>". */
export const MCP_TOOL_PREFIX = "MCP:";

/**
 * UI-only pseudo-tools the agent emits but never fires a real postToolUse for —
 * no I/O worth tracing.
 */
export const SUBAGENT_PSEUDO_TOOLS = new Set(["UpdateCurrentStep"]);

export const STATE_FILE_NAME = "langsmith_state.json";

export const LEGACY_STATE_FILE_NAME = "langsmith-state.json";

export const TRACING_POLICY_FILE_NAME = "langsmith_state_privacy.json";

export const LEGACY_TRACING_POLICY_FILE_NAME = "langsmith-state.privacy.json";

export const HOOK_LOG_FILE_NAME = "langsmith_hook.log";

export const NODE_PATH_CACHE_FILE_NAME = "langsmith_node.json";

export const HOOK_CONTINUE_OUTPUT = `${JSON.stringify({ continue: true })}\n`;

export const ENGINE_WORKER_COMMAND = "engine-worker";

export const ENGINE_STORAGE_DIR_NAME = "langsmith_engine";

export const JOB_EVENT_PREFIX = "cursor-job:";

export const JOB_REF_PREFIX = "cursor-turn:";

export const TOOL_JOB_REF_PREFIX = "cursor-tool:";

export const JOB_STORE_DIR_NAME = "jobs";

export const GH_LOGIN_MARKER_FILE = "langsmith_gh_login.json";

export const TOOL_PATH_INPUT_KEYS = ["file_path", "path", "target_file", "targetDirectory", "cwd"];

export const RUN_EVENT_PREFIX = "post:";

export const PATCH_EVENT_PREFIX = "patch:";

export const RUN_SNAPSHOT_FIELDS = [
  "id",
  "name",
  "run_type",
  "start_time",
  "end_time",
  "inputs",
  "outputs",
  "trace_id",
  "dotted_order",
  "tags",
  "error",
] as const;

export const RUN_PATCH_FIELDS = ["outputs", "end_time", "error"] as const;

export const CAPTURE_PUBLISHED_STATUS = "published";

export const CAPTURE_DUPLICATE_STATUS = "duplicate";

export const TURN_ON_OTHER_ACCOUNT_MESSAGE = "its first runs were saved under another API key";

export const SQLITE_EXPERIMENTAL_WARNING = /^SQLite is an experimental feature/;
