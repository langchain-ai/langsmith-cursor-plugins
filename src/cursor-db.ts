import { DatabaseSync } from "node:sqlite";
import type { BlobReader } from "./models/cursor-db.js";

export function openDbReader(dbPath: string): BlobReader {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const stmt = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
  return {
    get(key: string): Buffer | undefined {
      const row = stmt.get(key) as { value?: unknown } | undefined;
      const v = row?.value;
      if (typeof v === "string") return Buffer.from(v);
      if (v instanceof Uint8Array) return Buffer.from(v);
      return undefined;
    },
    close: () => db.close(),
  };
}
