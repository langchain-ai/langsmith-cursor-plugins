import type { LangSmithUploadWriterOptions } from "@langchain/plugins-base/tracing/upload";
import { loadConfig } from "./config.js";
import type { Config } from "./models/config.js";

export function writerOptions(config: Config, project: string): LangSmithUploadWriterOptions {
  return {
    destinations: [
      {
        apiKey: config.apiKey,
        apiUrl: config.apiUrl,
        projectName: config.locked.includes("project") ? config.project : project,
      },
    ],
    ...(config.replicas?.length ? { replicas: config.replicas } : {}),
    ...(config.locked.includes("project") ? { projectLocked: true } : {}),
    redact: config.redact,
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
