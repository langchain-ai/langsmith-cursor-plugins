/**
 * Read attachment bytes from Cursor's DB → multimodal part. Read-only, never throws.
 * Match bubble `path` (not `selectedImages[].uuid`).
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, join } from "node:path";
import type { ContentPart } from "./types.js";
import { isRecord } from "./normalize.js";
import * as logger from "./logger.js";

/** Skip attachments larger than this (raw bytes) — base64 inflates ~33% on top. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

/** Platform-aware default path to Cursor's global state.vscdb. */
export function defaultCursorDbPath(): string {
  const home = homedir();
  const tail = ["Cursor", "User", "globalStorage", "state.vscdb"];
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", ...tail);
    case "win32":
      return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), ...tail);
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), ...tail);
  }
}

/** Collapse whitespace runs so a typed prompt matches the stored bubble text. */
function normalizeWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Query a conversation's bubbles via built-in `node:sqlite`, read-only (no native dep). */
function queryBubbles(dbPath: string, conversationId: string): unknown[] {
  const like = `bubbleId:${conversationId}:%`;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT value FROM cursorDiskKV WHERE key LIKE ?").all(like) as Array<{
      value?: unknown;
    }>;
    const bubbles: unknown[] = [];
    for (const row of rows) {
      // TEXT comes back as a string; BLOB as a Uint8Array — handle both.
      const text =
        typeof row.value === "string"
          ? row.value
          : row.value instanceof Uint8Array
            ? Buffer.from(row.value).toString("utf-8")
            : undefined;
      if (text === undefined) continue;
      try {
        bubbles.push(JSON.parse(text));
      } catch {
        /* skip malformed bubble */
      }
    }
    return bubbles;
  } finally {
    db.close();
  }
}

/**
 * Collect `context.selectedImages[].path` from user bubbles matching `prompt`.
 * Empty prompt → the sole bubble with attachments, if unambiguous.
 */
export function selectedAttachmentPaths(bubbles: unknown[], prompt: string | undefined): string[] {
  const want = prompt ? normalizeWs(prompt) : "";

  const userImageBubbles = bubbles
    .filter((b): b is Record<string, unknown> => isRecord(b) && b.type === 1)
    .map((b) => ({
      text: typeof b.text === "string" ? normalizeWs(b.text) : "",
      paths: imagePathsOf(b),
    }))
    .filter((b) => b.paths.length > 0);

  let matched: { paths: string[] }[];
  if (want !== "") {
    matched = userImageBubbles.filter((b) => b.text === want);
  } else {
    // Image-only message: only attribute if exactly one candidate exists.
    const empties = userImageBubbles.filter((b) => b.text === "");
    matched = empties.length === 1 ? empties : [];
  }

  const seen = new Set<string>();
  const paths: string[] = [];
  for (const b of matched) {
    for (const p of b.paths) {
      if (!seen.has(p)) {
        seen.add(p);
        paths.push(p);
      }
    }
  }
  return paths;
}

/** Extract absolute file paths from a bubble's `context.selectedImages`. */
function imagePathsOf(bubble: Record<string, unknown>): string[] {
  const ctx = isRecord(bubble.context) ? bubble.context : undefined;
  const imgs = ctx && Array.isArray(ctx.selectedImages) ? ctx.selectedImages : [];
  const paths: string[] = [];
  for (const im of imgs) {
    if (isRecord(im) && typeof im.path === "string" && im.path) paths.push(im.path);
  }
  return paths;
}

/** Detect a file's MIME from magic bytes, falling back to its extension. */
export function sniffMime(buf: Buffer, path: string): string {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6) {
    const sig = buf.toString("ascii", 0, 6);
    if (sig === "GIF87a" || sig === "GIF89a") return "image/gif";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (buf.length >= 5 && buf.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";

  const ext = path.toLowerCase().split(".").pop() ?? "";
  const byExt: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
  };
  return byExt[ext] ?? "application/octet-stream";
}

/** A text placeholder content part used when a file can't be embedded. */
function placeholder(text: string): ContentPart {
  return { type: "text", text };
}

/** File → content part (`image`/`file`); a text placeholder if it can't be embedded. */
export function fileToContentPart(path: string): ContentPart {
  const name = basename(path);
  try {
    const st = statSync(path);
    if (!st.isFile()) {
      logger.warn(`attachments: not a file, skipping: ${path}`);
      return placeholder(`[attachment skipped: ${name} — not a file]`);
    }
    if (st.size > MAX_ATTACHMENT_BYTES) {
      logger.warn(`attachments: too large (${st.size} bytes), skipping: ${path}`);
      return placeholder(`[attachment too large: ${name} (${st.size} bytes)]`);
    }
    const buf = readFileSync(path);
    const mime = sniffMime(buf, path);
    const base64 = buf.toString("base64");
    if (mime.startsWith("image/")) return { type: "image", mime_type: mime, base64 };
    return { type: "file", mime_type: mime, base64, filename: name };
  } catch (err) {
    logger.warn(`attachments: read failed, skipping: ${path} (${err})`);
    return placeholder(`[attachment unavailable: ${name}]`);
  }
}

export interface ResolveAttachmentsOptions {
  conversationId: string;
  /** The turn's prompt — used to attribute the attachment to the right turn. */
  prompt?: string;
  /** Override the DB path; defaults to the platform Cursor globalStorage DB. */
  dbPath?: string;
  /** Injectable bubble reader (tests). Defaults to the `node:sqlite` query. */
  readBubbles?: (dbPath: string, conversationId: string) => unknown[];
}

/** Resolve a turn's attachments as content parts. Best-effort: returns `[]` on failure. */
export function resolveTurnAttachments(opts: ResolveAttachmentsOptions): ContentPart[] {
  try {
    const dbPath = opts.dbPath ?? defaultCursorDbPath();
    if (!existsSync(dbPath)) {
      logger.debug(`attachments: no Cursor DB at ${dbPath}`);
      return [];
    }
    const read = opts.readBubbles ?? queryBubbles;
    const bubbles = read(dbPath, opts.conversationId);
    const paths = selectedAttachmentPaths(bubbles, opts.prompt);
    if (paths.length === 0) return [];

    const parts: ContentPart[] = paths.map(fileToContentPart);
    if (parts.length > 0) {
      logger.log(`attachments: enriched turn with ${parts.length} attachment(s)`);
    }
    return parts;
  } catch (err) {
    logger.warn(`attachments: enrichment failed, skipping (${err})`);
    return [];
  }
}
