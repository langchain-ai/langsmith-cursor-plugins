export interface ResolveAttachmentsOptions {
  conversationId: string;
  /** The turn's prompt — used to attribute the attachment to the right turn. */
  prompt?: string;
  /** Override the DB path; defaults to the platform Cursor globalStorage DB. */
  dbPath?: string;
  /** Injectable bubble reader (tests). Defaults to the `node:sqlite` query. */
  readBubbles?: (dbPath: string, conversationId: string) => unknown[];
}
