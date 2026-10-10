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
export const CURSOR_ENGINE_WORKER_ARGUMENT_LIMITS = {
  sessionId: 1024,
  cwd: 4096,
  project: 512,
} as const;

export const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export const CURSOR_RUN_POST_EVENT_KIND = "run-post";
export const CURSOR_RUN_PATCH_EVENT_KIND = "run-patch";

export const CURSOR_ENGINE_NODE_SCRIPT = /\.(?:c|m)?js$|\.ts$/;

/** Read tools only, so a glob or grep naming SKILL.md is not counted as an invocation. */
export const READ_TOOLS = new Set(["read_file_v2", "ReadFile", "Read"]);

export const DEFAULT_SWEEP_IDLE_MINUTES = 360;

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
