/** Display name for the per-turn root (chain) run. */
export const TURN_RUN_NAME = "Cursor Turn";

/** Integration tag attached to every run's metadata. */
export const LS_INTEGRATION = "langsmith-cursor";

/** Default tags attached to the root turn run. */
export const DEFAULT_TAGS = ["cursor", "coding-agent"];

/** Default LangSmith project name when none is configured. */
export const DEFAULT_PROJECT = "cursor";

/**
 * Slash-command prefixes a user can type in the Cursor chat box to attach
 * LangSmith feedback to the turn they just saw. Matched case-insensitively on
 * the first whitespace-delimited token.
 */
export const FEEDBACK_COMMAND_PREFIXES = ["/langsmith", "/ls"];

/** LangSmith feedback key under which all user-typed feedback is recorded. */
export const FEEDBACK_KEY = "user_feedback";
