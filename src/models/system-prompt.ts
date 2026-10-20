import type { BlobReader } from "./cursor-db.js";

export interface Cursor {
  p: number;
}

export interface ResolveSystemPromptsOptions {
  conversationIds: string[];
  /** Override the DB path; defaults to the platform Cursor globalStorage DB. */
  dbPath?: string;
  /** Injectable reader factory (tests). Defaults to the read-only `node:sqlite` reader. */
  openReader?: (dbPath: string) => BlobReader;
}
