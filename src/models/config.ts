import type { LockableField } from "@langchain/plugins-base/settings";
import type { LangSmithUploadReplicaConfig } from "@langchain/plugins-base/tracing/upload";
import type { StringNodeRule } from "langsmith/anonymizer";

export interface Config {
  /** Master switch — tracing only runs when true. */
  enabled: boolean;
  /** Fallback for threads without an explicit override; independent of enabled. */
  defaultMuted: boolean;
  apiKey: string;
  apiUrl: string;
  project: string;
  debug: boolean;
  stateFilePath: string;
  replicas?: LangSmithUploadReplicaConfig[];
  /** Identity / repo / user metadata attached to every run. */
  customMetadata?: Record<string, unknown>;
  /** Enrich turns with image/file attachment bytes from Cursor's DB (default on). */
  attachmentsEnabled: boolean;
  /** Recover the turn's system prompt from Cursor's DB (default on). */
  systemPromptEnabled: boolean;
  /** Override the Cursor state.vscdb path used for DB enrichment. */
  cursorDbPath?: string;
  /** Redact detected secrets from traced data before upload (default on). */
  redact: boolean;
  sweepIdleMinutes: number;
  /** Extra user-supplied redaction rules (environment or common file config). */
  redactExtraRules?: StringNodeRule[];
  cwd: string;
  locked: LockableField[];
  noticeCooldown?: number | "off";
  apiUrlIsDefault: boolean;
  strictAuth: boolean;
  managedConfigProblem?: string;
}

export interface CursorExtensions {
  attachments?: boolean;
  system_prompt?: boolean;
  sweep_idle_minutes?: number;
  cursor_db_path?: string;
}

export interface EnvBooleanOptions {
  name: string;
  parse: (value: string) => boolean | undefined;
  restrictive: boolean;
}
