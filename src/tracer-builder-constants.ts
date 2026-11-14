export const BUILDER_STATE_VERSION = 1;

export const NOTE_EVENTS = {
  sessionStart: "sessionStart",
  beforeSubmitPrompt: "beforeSubmitPrompt",
  postToolUse: "postToolUse",
  postToolUseFailure: "postToolUseFailure",
  afterAgentResponse: "afterAgentResponse",
  afterAgentThought: "afterAgentThought",
  subagentStart: "subagentStart",
  subagentStop: "subagentStop",
  stop: "stop",
} as const;
