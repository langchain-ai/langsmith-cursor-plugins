import type { LangSmithUploadWriterOptions } from "@langchain/plugins-base/tracing/upload";
import {
  loginReplicaRefusal,
  refusedLoginReplicas,
  resolveUploadCredential,
  sdkSetting,
  type UploadCredential,
} from "@langchain/plugins-base/auth";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.js";
import { ENGINE_STORAGE_DIR_NAME } from "./constants.js";
import type { Config } from "./models/config.js";
import type { DestinationCredential } from "./models/writer-options.js";

export function storageRootFor(config: Config): string {
  return join(dirname(config.stateFilePath), ENGINE_STORAGE_DIR_NAME);
}

export function uploadCredential(config: Config): UploadCredential {
  return resolveUploadCredential({
    apiKey: sdkSetting(config.apiKey),
    apiUrl: config.apiUrl,
    apiUrlIsDefault: config.apiUrlIsDefault,
    profile: config.profile,
    workspaceId: config.workspaceId,
    agentId: config.agentId,
  });
}

export function uploadProblem(config: Config, credential: UploadCredential): string | undefined {
  if (credential.kind === "login")
    return config.replicas?.length
      ? loginReplicaRefusal(config.replicas, credential.apiUrl)
      : undefined;
  if (credential.kind !== "none" || config.replicas?.some((replica) => sdkSetting(replica.apiKey)))
    return undefined;
  return credential.reason;
}

export function replacingReplicaCount(config: Config): number {
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

export function destinationCredential(config: Config): DestinationCredential {
  const credential = uploadCredential(config);
  if (credential.kind === "none") return { apiKey: config.apiKey, apiUrl: config.apiUrl };
  const { kind: _kind, ...destination } = credential;
  return destination;
}

export function writerOptions(config: Config, project: string): LangSmithUploadWriterOptions {
  return {
    destinations: [
      {
        ...destinationCredential(config),
        ...(config.agentId === undefined ? {} : { agentId: config.agentId }),
        projectName: config.locked.includes("project") ? config.project : project,
      },
    ],
    ...(config.replicas?.length ? { replicas: config.replicas } : {}),
    ...(config.locked.includes("project") ? { projectLocked: true } : {}),
    redact: config.redact,
    storageRoot: storageRootFor(config),
    ...(config.redactExtraRules
      ? {
          redactExtraRules:
            config.redactExtraRules as LangSmithUploadWriterOptions["redactExtraRules"],
        }
      : {}),
  };
}

export function currentWriterOptions(
  cwd: string,
  project: string,
): LangSmithUploadWriterOptions | undefined {
  const config = loadConfig({ cwd });
  return config.managedConfigProblem === undefined ? writerOptions(config, project) : undefined;
}
