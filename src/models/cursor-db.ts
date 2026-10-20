/** A read-only key→bytes lookup over one DB connection. */
export interface BlobReader {
  get(key: string): Buffer | undefined;
  close(): void;
}
