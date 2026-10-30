import { refusedLoginReplicas, sdkSetting } from "@langchain/plugins-base/auth";
import {
  describeSetup,
  parseSetupArguments,
  writeSetupConfig,
} from "@langchain/plugins-base/settings";
import { homedir } from "node:os";
import { loadConfig } from "./config.js";
import { CURSOR_DIRECTORY_NAME, NOTICE_KINDS, SETUP_COMMAND_PATTERN } from "./constants.js";
import { uploadStatus } from "./notice.js";
import { getThreadTracingMode, mutingLocked, tracingPolicyPath } from "./tracing-policy.js";
import { destinationCredential, uploadCredential } from "./writer-options.js";
import type { Config } from "./models/config.js";
import type {
  BeforeSubmitPromptInput,
  PromptReply,
  SetupSignIn,
  UploadStatus,
} from "./models/types.js";

export function parseSetupCommand(prompt: string): string | undefined {
  const match = SETUP_COMMAND_PATTERN.exec(prompt);
  return match ? (match[1] ?? "") : undefined;
}

function replacingReplicaCount(config: Config): number {
  const replicas = config.replicas ?? [];
  const credential = uploadCredential(config);
  if (credential.kind === "api-key") return replicas.length;
  return replicas.filter(
    (replica) =>
      sdkSetting(replica.apiKey) !== undefined ||
      (credential.kind === "login" &&
        refusedLoginReplicas([replica], credential.apiUrl) === undefined),
  ).length;
}

function uploadStatusAsIfTracingOn(config: Config): UploadStatus {
  return uploadStatus({ ...config, enabled: true });
}

function signInOutcome(config: Config): SetupSignIn {
  const status = uploadStatusAsIfTracingOn(config);
  if (status.untraced || status.notice?.kind === NOTICE_KINDS.managed)
    return { signIn: "none", credentialProblem: status.notice?.text };
  return { signIn: status.credential.kind === "login" ? "login" : "api-key" };
}

function applySetup(argumentText: string, input: BeforeSubmitPromptInput): string {
  const requested = parseSetupArguments(argumentText);
  const path = writeSetupConfig(homedir(), CURSOR_DIRECTORY_NAME, requested);
  const config = loadConfig({ cwd: input.workspace_roots?.[0] });
  const mode = getThreadTracingMode(
    tracingPolicyPath(),
    input.conversation_id,
    config.defaultMuted,
    mutingLocked(config),
  );
  return describeSetup({
    path,
    requested,
    enabled: config.enabled,
    project: config.project,
    apiUrl: destinationCredential(config).apiUrl,
    ...(config.agentId === undefined ? {} : { agentId: config.agentId }),
    muted: mode === "metadata",
    replicaCount: replacingReplicaCount(config),
    ...signInOutcome(config),
  });
}

export function runSetupCommand(argumentText: string, input: BeforeSubmitPromptInput): PromptReply {
  try {
    return { continue: false, user_message: applySetup(argumentText, input) };
  } catch (error) {
    return {
      continue: false,
      user_message: error instanceof Error ? error.message : String(error),
    };
  }
}
