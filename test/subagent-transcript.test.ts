import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { cpSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseSubagentTranscript } from "../src/normalize.js";
import { resolveSubagentTranscript } from "../src/subagent-transcript.js";
import { LINE_READ_CHUNK_BYTES } from "../src/constants.js";
import { readLines } from "../src/utils/files.js";

const PARENT_CONV = "6bd3db3e-e838-485e-befc-b5f0d05b18cd";
const CHILD_CONV = "3e6a5f09-8e10-4614-8714-152f3cc1b719";
const PARENT_TRANSCRIPT = join(
  process.cwd(),
  `test/fixtures/agent-transcripts/${PARENT_CONV}/${PARENT_CONV}.jsonl`,
);
const CHILD_TRANSCRIPT = join(
  process.cwd(),
  `test/fixtures/agent-transcripts/${PARENT_CONV}/subagents/${CHILD_CONV}.jsonl`,
);
const TASK = "Thoroughness: very thorough.\n\nTask: Read and inspect the repository";

function rows(path: string): unknown[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("parseSubagentTranscript", () => {
  const parsed = parseSubagentTranscript(rows(CHILD_TRANSCRIPT));

  it("extracts the subagent's internal tool calls", () => {
    expect(parsed.toolCalls.length).toBeGreaterThan(0);
    const names = new Set(parsed.toolCalls.map((t) => t.name));
    expect(names).toContain("Read");
    expect(names).toContain("Glob");
    expect(names).toContain("Grep");
  });

  it("drops UI-only pseudo-tools", () => {
    expect(parsed.toolCalls.some((t) => t.name === "UpdateCurrentStep")).toBe(false);
  });

  it("recovers the subagent's final answer text", () => {
    expect(parsed.resultText && parsed.resultText.length).toBeGreaterThan(0);
    expect(parsed.resultText).not.toContain("[REDACTED]");
  });

  it("ignores malformed / non-assistant rows gracefully", () => {
    expect(parseSubagentTranscript([null, 42, { role: "user" }, "x"]).toolCalls).toEqual([]);
  });
});

describe("resolveSubagentTranscript", () => {
  it("matches the right subagent file by task text and returns the child conv id", () => {
    const resolved = resolveSubagentTranscript(PARENT_TRANSCRIPT, TASK);
    expect(resolved).toBeDefined();
    expect(resolved!.childConversationId).toBe(CHILD_CONV);
    expect(resolved!.toolCalls.length).toBeGreaterThan(0);
    expect(resolved!.resultText).toBeTruthy();
  });

  it("picks the older transcript whose first user row matches the task", () => {
    const subagents = join(mkdtempSync(join(tmpdir(), "subagents-")), "subagents");
    cpSync(CHILD_TRANSCRIPT, join(subagents, `${CHILD_CONV}.jsonl`));
    utimesSync(join(subagents, `${CHILD_CONV}.jsonl`), 1, 1);
    const other = { role: "user", message: { content: [{ type: "text", text: "Another task" }] } };
    writeFileSync(join(subagents, "newer.jsonl"), `${JSON.stringify(other)}\n`);
    const resolved = resolveSubagentTranscript(join(subagents, "..", "parent.jsonl"), TASK);
    expect(resolved).toEqual(resolveSubagentTranscript(PARENT_TRANSCRIPT, TASK));
  });

  it("returns undefined when the subagents directory is absent", () => {
    expect(resolveSubagentTranscript("/nonexistent/path/conv.jsonl", TASK)).toBeUndefined();
  });

  it("returns undefined for a null transcript path", () => {
    expect(resolveSubagentTranscript(null, TASK)).toBeUndefined();
  });
});

describe("readLines", () => {
  it("yields the same lines as splitting the whole file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "read-lines-")), "rows.jsonl");
    const long = "é".repeat(LINE_READ_CHUNK_BYTES);
    writeFileSync(path, `first!\n${long}\n\nmiddle ✓\nlast`);
    expect([...readLines(path)]).toEqual(readFileSync(path, "utf-8").split("\n"));
  });
});
