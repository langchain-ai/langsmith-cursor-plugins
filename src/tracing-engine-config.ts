import type { Config } from "./config.js";
import { CURSOR_ENGINE_WORKER_ARGUMENT_LIMITS } from "./constants.js";
import { isValidBoundedText } from "./utils/validation/text.js";
import type { CursorUploadReplica } from "./models/tracing-engine.js";

export function validateProjectName(project: string): void {
  if (!isValidBoundedText(project, CURSOR_ENGINE_WORKER_ARGUMENT_LIMITS.project)) {
    throw new Error("Shared trace worker project is invalid");
  }
}

export function writerOptions(config: Config, projectName = config.project) {
  return {
    destinations: [{ apiKey: config.apiKey, apiUrl: config.apiUrl, projectName }],
    ...(config.replicas === undefined ? {} : { replicas: uploadReplicas(config.replicas) }),
    redact: config.redact,
    ...(config.redactExtraRules === undefined
      ? {}
      : {
          redactExtraRules: config.redactExtraRules.map((rule) => ({
            pattern: rule.pattern,
            ...(rule.replace === undefined ? {} : { replace: rule.replace }),
          })),
        }),
  };
}

function uploadReplicas(replicas: NonNullable<Config["replicas"]>): CursorUploadReplica[] {
  return replicas.map((replica) => {
    if (Array.isArray(replica)) {
      const [projectName, updates] = replica;
      return {
        projectName,
        ...(updates === undefined ? {} : { updates }),
      };
    }
    return {
      ...(replica.apiKey === undefined ? {} : { apiKey: replica.apiKey }),
      ...(replica.apiUrl === undefined ? {} : { apiUrl: replica.apiUrl }),
      ...(replica.projectName === undefined ? {} : { projectName: replica.projectName }),
      ...(replica.workspaceId === undefined ? {} : { workspaceId: replica.workspaceId }),
      ...(replica.updates === undefined ? {} : { updates: replica.updates }),
    };
  });
}
