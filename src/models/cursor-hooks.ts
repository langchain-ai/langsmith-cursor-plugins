/** The commands Cursor runs for each event, as they appear in hooks.json. */
export interface CursorHooksFile {
  version?: number;
  hooks?: Record<string, Array<{ command?: string; failClosed?: boolean; timeout?: number }>>;
}
