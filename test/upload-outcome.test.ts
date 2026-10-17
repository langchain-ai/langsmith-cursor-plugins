import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { saveTurnForUpload } from "../src/tracing-engine.js";
import { T0, testConfig, turn } from "./utils/state.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: () => {
    const child = new EventEmitter();
    setImmediate(() => child.emit("error", new Error("worker launch is mocked")));
    return child;
  },
}));

function upload(dir: string, tracingMode: "full" | "metadata" = "full"): Promise<boolean> {
  return saveTurnForUpload(testConfig(join(dir, "state.json")), {
    buffer: turn("g1", T0, { tracingMode, prompt: "PRIVATE_PROMPT" }),
    conversationId: "c1",
    turnNum: 1,
    project: "cursor",
  });
}

function savedText(dir: string): string {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}

describe("a stopped turn is only settled once its traces are saved", { timeout: 60_000 }, () => {
  it("settles once the traces are saved for the uploader", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ls-cursor-saved-"));
    expect(await upload(dir)).toBe(true);
    expect(savedText(dir)).toContain("PRIVATE_PROMPT");
  });

  it("stays unsettled when the traces cannot be saved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ls-cursor-unsaved-"));
    writeFileSync(join(dir, "langsmith_engine"), "not a directory");
    expect(await upload(dir)).toBe(false);
  });

  it("never writes a muted turn's content to disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ls-cursor-muted-"));
    expect(await upload(dir, "metadata")).toBe(true);
    expect(savedText(dir)).toContain("Cursor Turn 1");
    expect(savedText(dir)).not.toContain("PRIVATE_PROMPT");
  });
});
