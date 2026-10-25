import type { LangSmithUploadWriterOptions } from "@langchain/plugins-base/tracing/upload";

export type DestinationCredential = Omit<
  LangSmithUploadWriterOptions["destinations"][number],
  "projectName"
>;
