import type { HookPlacement } from "./models/conversation-steps.js";

// ─── Protobuf field numbers (wire-stable; verified against Cursor 3.7.19) ─────

/** ConversationStateStructure.turns — repeated bytes (each = a turn blob id). */
export const STATE_TURNS_FIELD = 8;
/** ConversationTurnStructure.agent_conversation_turn — oneof case 1. */
export const TURN_AGENT_FIELD = 1;
/** AgentConversationTurnStructure.steps — repeated bytes (each = a step blob id). */
export const AGENT_STEPS_FIELD = 2;
/** ConversationStep oneof: assistant_message=1, tool_call=2, thinking_message=3. */
export const STEP_ASSISTANT_FIELD = 1;
export const STEP_TOOL_FIELD = 2;
export const STEP_THINKING_FIELD = 3;
/** AssistantMessage.text=1 / ThinkingMessage.text=1. */
export const MESSAGE_TEXT_FIELD = 1;
/** ThinkingMessage.duration_ms=2. */
export const THINKING_DURATION_FIELD = 2;
/** ToolCall.tool_use_id — string. Drift-added field, stable across all tool steps. */
export const TOOLCALL_TOOL_USE_ID_FIELD = 57;
/** ToolCall.hook_additional_contexts=54 — not the tool oneof; skip when sniffing it. */
export const TOOLCALL_HOOK_CONTEXTS_FIELD = 54;
export const TURN_USER_MESSAGE_FIELD = 1;
export const USER_MESSAGE_ID_FIELD = 2;
export const USER_MESSAGE_HOOK_CONTEXTS_FIELD = 21;
export const HOOK_CONTEXT_NAME_FIELD = 1;
export const HOOK_CONTEXT_TEXT_FIELD = 2;

/** ToolCall oneof field number → human-readable tool name (fallback labels only). */
export const TOOL_FIELD_NAMES: Record<number, string> = {
  1: "Shell",
  3: "Delete",
  4: "Glob",
  5: "Grep",
  8: "Read",
  9: "UpdateTodos",
  10: "ReadTodos",
  12: "Edit",
  13: "Ls",
  14: "ReadLints",
  15: "MCP",
  16: "SemSearch",
  17: "CreatePlan",
  18: "WebSearch",
  19: "Task",
  20: "ListMcpResources",
  21: "ReadMcpResource",
  22: "ApplyAgentDiff",
  23: "AskQuestion",
  24: "Fetch",
  25: "SwitchMode",
  28: "GenerateImage",
  29: "RecordScreen",
  30: "ComputerUse",
  31: "WriteShellStdin",
  32: "Reflect",
  33: "SetupVmEnvironment",
  34: "Truncated",
  35: "StartGrindExecution",
  36: "StartGrindPlanning",
  37: "WebFetch",
  38: "ReportBugfixResults",
  39: "AiAttribution",
  40: "PrManagement",
  41: "McpAuth",
  42: "Await",
  43: "BlameByFilePath",
  44: "GetMcpTools",
  45: "ReportBug",
  46: "SetActiveBranch",
  48: "CommunicateUpdate",
  49: "SendFinalSummary",
  50: "UpdatePrCodeTour",
  51: "ReplaceEnv",
  52: "EditPrLabels",
  53: "RecordCiInvestigationFindings",
  55: "SendMessage",
  58: "SendToUser",
};

export const HOOK_EVENT_PLACEMENT = new Map<string, HookPlacement>([
  ["sessionStart", { direction: "input", scope: "turn" }],
  ["sessionEnd", { direction: "output", scope: "turn" }],
  ["preToolUse", { direction: "input", scope: "tool" }],
  ["postToolUse", { direction: "output", scope: "tool" }],
  ["postToolUseFailure", { direction: "output", scope: "tool" }],
  ["subagentStart", { direction: "input", scope: "turn" }],
  ["subagentStop", { direction: "output", scope: "turn" }],
  ["beforeShellExecution", { direction: "input", scope: "tool" }],
  ["afterShellExecution", { direction: "output", scope: "tool" }],
  ["beforeMCPExecution", { direction: "input", scope: "tool" }],
  ["afterMCPExecution", { direction: "output", scope: "tool" }],
  ["beforeReadFile", { direction: "input", scope: "tool" }],
  ["afterFileEdit", { direction: "output", scope: "tool" }],
  ["beforeSubmitPrompt", { direction: "input", scope: "turn" }],
  ["preCompact", { direction: "input", scope: "turn" }],
  ["stop", { direction: "output", scope: "turn" }],
  ["afterAgentResponse", { direction: "output", scope: "turn" }],
  ["afterAgentThought", { direction: "output", scope: "turn" }],
  ["beforeTabFileRead", { direction: "input", scope: "turn" }],
  ["afterTabFileEdit", { direction: "output", scope: "turn" }],
  ["workspaceOpen", { direction: "input", scope: "turn" }],
]);

export const UNKNOWN_HOOK_PLACEMENT: HookPlacement = { direction: "input", scope: "turn" };
