import { uploadingReplicaCount } from "@langchain/plugins-base/auth";
import { matchPromptCommand, runPromptCommand } from "@langchain/plugins-base/plugin";
import type { PromptCommandHandler } from "@langchain/plugins-base/plugin";
import { applySetup } from "@langchain/plugins-base/settings";
import type { SetupState } from "@langchain/plugins-base/settings";
import { homedir } from "node:os";
import { loadConfig } from "./config.js";
import {
  CURSOR_DIRECTORY_NAME,
  MUTE_LOCKED_MESSAGE,
  NOTICE_KINDS,
  PROMPT_COMMANDS,
  TRACING_DISABLED_NOTE,
} from "./constants.js";
import { error as logError, initLogger, warn as logWarn } from "./logger.js";
import { uploadStatus } from "./notice.js";
import { atomicUpdateState } from "./state.js";
import { reduceBeforeSubmitPrompt } from "./reducer.js";
import {
  getThreadTracingMode,
  mutingLocked,
  setThreadTracingMode,
  tracingPolicyPath,
} from "./tracing-policy.js";
import { originFromConfig } from "./turn-origin.js";
import { destinationCredential, uploadCredential } from "./writer-options.js";
import type { Config } from "./models/config.js";
import type {
  BeforeSubmitPromptInput,
  PromptCommandName,
  PromptReply,
  SetupSignIn,
  TracingMode,
  TurnMode,
  TurnStarter,
} from "./models/types.js";

function requireNativeIds(input: BeforeSubmitPromptInput): void {
  if (
    !input.conversation_id ||
    typeof input.conversation_id !== "string" ||
    !input.generation_id ||
    typeof input.generation_id !== "string"
  ) {
    throw new Error("Nonempty native conversation_id and generation_id required; update Cursor");
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logUntraced(detail: string): void {
  logError(`Could not save tracing preference/turn snapshot: ${detail}. Turn not traced.`);
}

async function saveThreadMode(input: BeforeSubmitPromptInput, mode: TracingMode): Promise<string> {
  requireNativeIds(input);
  const config = loadConfig({ cwd: input.workspace_roots?.[0] });
  initLogger(config.debug);
  if (mode === "full" && mutingLocked(config)) return MUTE_LOCKED_MESSAGE;
  const result = await setThreadTracingMode(tracingPolicyPath(), input.conversation_id, mode);
  const change = mode === "metadata" ? "muted (metadata-only)" : "unmuted (full content)";
  let tracingNote = "";
  if (config.managedConfigProblem !== undefined) {
    tracingNote = ` ${config.managedConfigProblem}`;
  } else if (!config.enabled) {
    tracingNote = TRACING_DISABLED_NOTE;
  }
  const warning = result.warning ? ` Warning: ${result.warning}` : "";
  return `Thread tracing ${change}. Preference saved for the next turn; the current turn is unchanged.${tracingNote}${warning}`;
}

function signInOutcome(config: Config): SetupSignIn {
  const status = uploadStatus({ ...config, enabled: true });
  if (status.untraced || status.notice?.kind === NOTICE_KINDS.managed)
    return { signIn: "none", credentialProblem: status.notice?.text };
  return { signIn: status.credential.kind === "login" ? "login" : "api-key" };
}

function setupState(input: BeforeSubmitPromptInput): SetupState {
  const config = loadConfig({ cwd: input.workspace_roots?.[0] });
  const mode = getThreadTracingMode(
    tracingPolicyPath(),
    input.conversation_id,
    config.defaultMuted,
    mutingLocked(config),
  );
  return {
    enabled: config.enabled,
    project: config.project,
    apiUrl: destinationCredential(config).apiUrl,
    ...(config.agentId === undefined ? {} : { agentId: config.agentId }),
    muted: mode === "metadata",
    replicaCount: uploadingReplicaCount(config.replicas, uploadCredential(config)),
    ...signInOutcome(config),
  };
}

function logFailure(
  handler: PromptCommandHandler<BeforeSubmitPromptInput>,
): PromptCommandHandler<BeforeSubmitPromptInput> {
  return async (argumentText, input) => {
    try {
      return await handler(argumentText, input);
    } catch (error) {
      logUntraced(errorDetail(error));
      throw error;
    }
  };
}

const COMMAND_HANDLERS: Record<PromptCommandName, PromptCommandHandler<BeforeSubmitPromptInput>> = {
  setup: logFailure((argumentText, input) =>
    applySetup(argumentText, {
      home: homedir(),
      harnessDirectory: CURSOR_DIRECTORY_NAME,
      readState: () => setupState(input),
    }),
  ),
  mute: logFailure((_argumentText, input) => saveThreadMode(input, "metadata")),
  unmute: logFailure((_argumentText, input) => saveThreadMode(input, "full")),
};

async function saveTurnSnapshot(
  input: BeforeSubmitPromptInput,
  config: Config,
  mode: TurnMode,
): Promise<void> {
  await atomicUpdateState(config.stateFilePath, (s) =>
    reduceBeforeSubmitPrompt(s, input, Date.now(), mode, originFromConfig(config, input)),
  );
}

/** Synchronous command hook contract, not an LLM skill or slash-command expansion. */
export async function handlePromptSubmit(
  input: BeforeSubmitPromptInput,
  startTurn: TurnStarter = saveTurnSnapshot,
): Promise<PromptReply> {
  const command =
    typeof input.prompt === "string"
      ? matchPromptCommand(input.prompt, PROMPT_COMMANDS)
      : undefined;
  if (command)
    return {
      continue: false,
      user_message: await runPromptCommand(command, COMMAND_HANDLERS, input),
    };
  try {
    requireNativeIds(input);
    const config = loadConfig({ cwd: input.workspace_roots?.[0] });
    initLogger(config.debug);
    // Even master-off launches need evidence if tracing is enabled before stop.
    const { problem, notice, untraced } = uploadStatus(config);
    const enabled = config.enabled && problem === undefined;
    const mode = getThreadTracingMode(
      tracingPolicyPath(),
      input.conversation_id,
      config.defaultMuted,
      mutingLocked(config),
    );
    if (notice && untraced && config.strictAuth)
      return { continue: false, user_message: notice.text };
    if (notice) logWarn(notice.text);
    await startTurn(input, config, enabled ? mode : "off");
    return { continue: true };
  } catch (error) {
    logUntraced(errorDetail(error));
    return { continue: true };
  }
}
