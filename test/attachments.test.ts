import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sniffMime,
  fileToContentPart,
  selectedAttachmentPaths,
  resolveTurnAttachments,
} from "../src/attachments.js";

// Minimal but valid magic-byte headers for sniff tests.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const PDF = Buffer.from("%PDF-1.7\n...", "ascii");

function tmpFile(name: string, data: Buffer | string): string {
  const dir = mkdtempSync(join(tmpdir(), "attach-"));
  const path = join(dir, name);
  writeFileSync(path, data);
  return path;
}

/** A user-message bubble (type 1) carrying selectedImages, mirroring the DB shape. */
function userBubble(text: string, paths: string[]): Record<string, unknown> {
  return {
    type: 1,
    text,
    context: { selectedImages: paths.map((p, i) => ({ uuid: `uuid-${i}`, path: p })) },
  };
}

describe("sniffMime", () => {
  it("detects images from magic bytes regardless of extension", () => {
    // Cursor stores a JPEG under a .png filename — magic bytes must win.
    expect(sniffMime(PNG, "x.bin")).toBe("image/png");
    expect(sniffMime(JPEG, "IMG_5041-abc.png")).toBe("image/jpeg");
    expect(sniffMime(PDF, "doc.pdf")).toBe("application/pdf");
  });

  it("falls back to extension, then octet-stream", () => {
    expect(sniffMime(Buffer.from("hello"), "notes.txt")).toBe("text/plain");
    expect(sniffMime(Buffer.from("\x00\x01\x02"), "mystery.xyz")).toBe("application/octet-stream");
  });
});

describe("fileToContentPart", () => {
  it("emits an image part with mime_type + base64 for an image file", () => {
    const part = fileToContentPart(tmpFile("shot.png", PNG));
    expect(part).toEqual({ type: "image", mime_type: "image/png", base64: PNG.toString("base64") });
  });

  it("emits a file part for non-images, with filename", () => {
    const part = fileToContentPart(tmpFile("report.pdf", PDF));
    expect(part).toMatchObject({
      type: "file",
      mime_type: "application/pdf",
      filename: "report.pdf",
    });
    expect((part as { base64: string }).base64).toBe(PDF.toString("base64"));
  });

  it("skips a missing file (returns undefined, never throws)", () => {
    expect(fileToContentPart("/no/such/file.png")).toBeUndefined();
  });
});

describe("selectedAttachmentPaths", () => {
  it("matches the user bubble whose text equals the prompt", () => {
    const bubbles = [
      userBubble("describe this image to me", ["/img/a.png"]),
      userBubble("unrelated turn", ["/img/b.png"]),
    ];
    expect(selectedAttachmentPaths(bubbles, "describe this image to me")).toEqual(["/img/a.png"]);
  });

  it("tolerates whitespace differences and dedupes paths", () => {
    const bubbles = [userBubble("what's   in this\nimage?", ["/img/a.png", "/img/a.png"])];
    expect(selectedAttachmentPaths(bubbles, "what's in this image?")).toEqual(["/img/a.png"]);
  });

  it("does not attribute when no bubble text matches the prompt", () => {
    const bubbles = [userBubble("a different prompt", ["/img/a.png"])];
    expect(selectedAttachmentPaths(bubbles, "describe this image to me")).toEqual([]);
  });

  it("ignores non-user bubbles", () => {
    const assistant = { type: 2, text: "p", context: { selectedImages: [{ path: "/img/x.png" }] } };
    expect(selectedAttachmentPaths([assistant], "p")).toEqual([]);
  });

  it("attributes an image-only message only when unambiguous", () => {
    expect(selectedAttachmentPaths([userBubble("", ["/img/only.png"])], "")).toEqual([
      "/img/only.png",
    ]);
    // Two empty-text image bubbles → ambiguous → skip.
    const two = [userBubble("", ["/img/a.png"]), userBubble("", ["/img/b.png"])];
    expect(selectedAttachmentPaths(two, "")).toEqual([]);
  });
});

describe("resolveTurnAttachments (end-to-end, injected reader)", () => {
  it("reads the matched bubble's file into a content part", () => {
    const path = tmpFile("describe.png", PNG);
    const parts = resolveTurnAttachments({
      conversationId: "conv-1",
      prompt: "describe this image to me",
      dbPath: tmpFile("fake.vscdb", "x"), // must exist; reader is injected below
      readBubbles: () => [userBubble("describe this image to me", [path])],
    });
    expect(parts).toEqual([
      { type: "image", mime_type: "image/png", base64: PNG.toString("base64") },
    ]);
  });

  it("returns [] when the DB path does not exist (no crash)", () => {
    expect(
      resolveTurnAttachments({ conversationId: "c", prompt: "p", dbPath: "/no/such/state.vscdb" }),
    ).toEqual([]);
  });

  it("returns [] when the reader throws (locked DB / no sqlite3)", () => {
    const parts = resolveTurnAttachments({
      conversationId: "c",
      prompt: "p",
      dbPath: tmpFile("fake.vscdb", "x"),
      readBubbles: () => {
        throw new Error("database is locked");
      },
    });
    expect(parts).toEqual([]);
  });
});
