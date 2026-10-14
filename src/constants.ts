/** Display name for the per-turn root (chain) run. */
export const TURN_RUN_NAME = "Cursor Turn";

/** Display name for the synthetic skill run, matching Claude Code's Skill tool. */
export const SKILL_RUN_NAME = "Skill";

/** Default tags attached to the root turn run. */
export const DEFAULT_TAGS = ["cursor", "coding-agent"];

/** Default LangSmith project name when none is configured. */
export const DEFAULT_PROJECT = "cursor";

export const DEFAULT_SWEEP_IDLE_MINUTES = 360;

export const DEFAULT_API_URL = "https://api.smith.langchain.com";

export const CURSOR_DIRECTORY_NAME = ".cursor";

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
