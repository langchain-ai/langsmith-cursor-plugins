export interface SweepUploadPayload extends Record<string, unknown> {
  extra?: { metadata?: Record<string, unknown> };
  inputs?: Record<string, unknown>;
  session_name?: string;
}

export interface SweepHttpUpload {
  action: "post" | "patch";
  runId?: string;
  payload: SweepUploadPayload;
}
