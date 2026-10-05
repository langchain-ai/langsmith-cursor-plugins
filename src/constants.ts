/** Display name for the per-turn root (chain) run. */
export const TURN_RUN_NAME = "Cursor Turn";

/** Display name for the synthetic skill run, matching Claude Code's Skill tool. */
export const SKILL_RUN_NAME = "Skill";

/** Default tags attached to the root turn run. */
export const DEFAULT_TAGS = ["cursor", "coding-agent"];

/** Default LangSmith project name when none is configured. */
export const DEFAULT_PROJECT = "cursor";

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
