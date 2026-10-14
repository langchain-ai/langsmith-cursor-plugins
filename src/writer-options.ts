import type { LangSmithUploadWriterOptions } from "@langchain/plugins-base/tracing/upload";
import type { Config } from "./models/config.js";

export function writerOptions(config: Config, project: string): LangSmithUploadWriterOptions {
  return {
    destinations: [{ apiKey: config.apiKey, apiUrl: config.apiUrl, projectName: project }],
    ...(config.replicas?.length ? { replicas: config.replicas } : {}),
    redact: config.redact,
    ...(config.redactExtraRules
      ? {
          redactExtraRules:
            config.redactExtraRules as LangSmithUploadWriterOptions["redactExtraRules"],
        }
      : {}),
  };
}
