import type { Config } from "./config.js";
import type {
  AfterAgentResponseInput,
  AfterAgentThoughtInput,
  BeforeSubmitPromptInput,
  PostToolUseFailureInput,
  PostToolUseInput,
  SessionStartInput,
  StopInput,
  SubagentStartInput,
  SubagentStopInput,
  TracingState,
  TurnBuffer,
  TurnOrigin,
} from "./types.js";

export type BuilderSettings = Pick<
  Config,
  | "attachmentsEnabled"
  | "systemPromptEnabled"
  | "cursorDbPath"
  | "captureHookOutputs"
  | "defaultMuted"
  | "locked"
  | "sweepIdleMinutes"
  | "stateFilePath"
  | "cwd"
>;

export type CursorHookInput =
  | SessionStartInput
  | BeforeSubmitPromptInput
  | PostToolUseInput
  | PostToolUseFailureInput
  | AfterAgentResponseInput
  | AfterAgentThoughtInput
  | SubagentStartInput
  | SubagentStopInput
  | StopInput;

export type NoteDetails = {
  input: CursorHookInput;
  time: number;
  origin: TurnOrigin;
  settings: BuilderSettings;
};

export interface PostedRun {
  postedAtMs: number;
  closed: boolean;
}

export interface BuilderState {
  version: number;
  tracing: TracingState;
  posted: Record<string, PostedRun>;
}

export interface TurnToSend {
  conversationId: string;
  buffer: TurnBuffer;
  turnNum: number;
  origin: TurnOrigin;
  savedAtMs: number;
  enrich: boolean;
}
