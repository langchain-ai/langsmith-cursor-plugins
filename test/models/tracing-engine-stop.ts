export interface UploadMetadata extends Record<string, unknown> {
  thread_id?: string;
  turn_id?: string;
  status?: string;
}

export interface UploadExtra extends Record<string, unknown> {
  metadata?: UploadMetadata;
}

export interface UploadPayload extends Record<string, unknown> {
  end_time?: number | string;
  error?: string;
  extra?: UploadExtra;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  parent_run_id?: string | null;
  session_name?: string;
}

export interface Upload {
  action: "post" | "patch";
  runId: string | undefined;
  path: string;
  payload: UploadPayload;
}

export interface CapturedRunMetadata extends Record<string, unknown> {
  subagentId?: string;
}

export interface CapturedRunSnapshot extends Record<string, unknown> {
  parent_run_id?: string;
}

export interface CapturedRunPayload extends Record<string, unknown> {
  run?: CapturedRunSnapshot;
}

export interface CapturedRunRecord extends Record<string, unknown> {
  eventId: string;
  eventKind: string;
  runId: string;
  normalizedPayload: CapturedRunPayload;
  metadataProvenance: CapturedRunMetadata;
  dependencies?: Array<{ eventId: string }>;
}
