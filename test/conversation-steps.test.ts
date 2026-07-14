import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanFields,
  decodeStep,
  groupSteps,
  resolveTurnSteps,
  type Step,
  type BlobReader,
} from "../src/conversation-steps.js";

/** Real empty file so existsSync(dbPath) passes; the reader is injected. */
function tmpDb(): string {
  const path = join(mkdtempSync(join(tmpdir(), "convsteps-")), "state.vscdb");
  writeFileSync(path, "");
  return path;
}

// ─── Minimal protobuf encoders ───────────────────────────────────────────────

function varint(n: number): number[] {
  const bytes: number[] = [];
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  bytes.push(n);
  return bytes;
}
function lenField(field: number, value: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(varint((field << 3) | 2)),
    Buffer.from(varint(value.length)),
    value,
  ]);
}
function varintField(field: number, value: number): Buffer {
  return Buffer.concat([Buffer.from(varint((field << 3) | 0)), Buffer.from(varint(value))]);
}
const str = (s: string): Buffer => Buffer.from(s, "utf-8");

function assistantStep(text: string): Buffer {
  return lenField(1, lenField(1, str(text)));
}
function thinkingStep(text: string, durationMs: number): Buffer {
  return lenField(3, Buffer.concat([lenField(1, str(text)), varintField(2, durationMs)]));
}
function toolStep(toolField: number, toolUseId: string): Buffer {
  const toolCall = Buffer.concat([lenField(toolField, str("args")), lenField(57, str(toolUseId))]);
  return lenField(2, toolCall);
}

describe("decodeStep", () => {
  it("decodes thinking, assistant, and tool steps", () => {
    expect(decodeStep(thinkingStep("pondering", 82))).toEqual({
      kind: "thinking",
      text: "pondering",
      durationMs: 82,
    });
    expect(decodeStep(assistantStep("the answer"))).toEqual({
      kind: "assistant",
      text: "the answer",
    });
    expect(decodeStep(toolStep(8, "tool_abc"))).toEqual({
      kind: "tool",
      toolUseId: "tool_abc",
      toolField: 8,
      toolName: "Read",
    });
  });

  it("tolerates unmapped tool fields, unknown steps, and truncated blobs", () => {
    expect(decodeStep(toolStep(999, "tool_xyz"))).toMatchObject({
      toolField: 999,
      toolName: undefined,
    });
    expect(decodeStep(varintField(7, 1))).toBeUndefined();
    expect(scanFields(Buffer.from([(1 << 3) | 2, 50, 0x01, 0x02]))).toEqual([]);
  });
});

describe("groupSteps", () => {
  it("splits into rounds at each tool→text boundary; trailing text is the final round", () => {
    const steps: Step[] = [
      { kind: "thinking", text: "plan" },
      { kind: "assistant", text: "I will look" },
      { kind: "tool", toolUseId: "a", toolField: 8, toolName: "Read" },
      { kind: "tool", toolUseId: "b", toolField: 5, toolName: "Grep" },
      { kind: "thinking", text: "more" },
      { kind: "tool", toolUseId: "c", toolField: 1, toolName: "Shell" },
      { kind: "assistant", text: "done" },
    ];
    const rounds = groupSteps(steps);
    expect(rounds).toHaveLength(3);
    expect(rounds[0].assistantText).toBe("I will look");
    expect(rounds[0].toolSteps.map((t) => t.toolUseId)).toEqual(["a", "b"]);
    expect(rounds[1].toolSteps.map((t) => t.toolUseId)).toEqual(["c"]);
    expect(rounds[2].assistantText).toBe("done");
    expect(rounds[2].toolSteps).toHaveLength(0);
  });
});

// ─── resolveTurnSteps ─────────────────────────────────────────────────────────

/** Map-backed reader for a conversation with the given turns' step blobs. */
function buildReader(conversationId: string, turns: Buffer[][]): BlobReader {
  const store = new Map<string, Buffer>();
  const turnIds: Buffer[] = [];
  turns.forEach((steps, ti) => {
    const stepIdBufs: Buffer[] = [];
    steps.forEach((stepBlob, si) => {
      const stepId = str(`t${ti}s${si}`);
      store.set(`agentKv:blob:${stepId.toString("hex")}`, stepBlob);
      stepIdBufs.push(stepId);
    });
    const agent = Buffer.concat(stepIdBufs.map((id) => lenField(2, id)));
    const turnId = str(`turn${ti}`);
    store.set(`agentKv:blob:${turnId.toString("hex")}`, lenField(1, agent));
    turnIds.push(turnId);
  });
  const state = Buffer.concat(turnIds.map((id) => lenField(8, id)));
  store.set(
    `composerData:${conversationId}`,
    Buffer.from(JSON.stringify({ conversationState: state.toString("hex") })),
  );
  return { get: (k) => store.get(k), close: () => {} };
}

describe("resolveTurnSteps", () => {
  const conv = "conv-1";
  const turnA = [thinkingStep("A", 1), toolStep(8, "tool_x"), toolStep(5, "tool_y")];
  const turnB = [thinkingStep("B", 2), toolStep(1, "tool_m"), assistantStep("final")];

  it("selects the turn whose tool ids overlap the hook buffer", () => {
    const reader = buildReader(conv, [turnA, turnB]);
    const steps = resolveTurnSteps({
      conversationId: conv,
      toolUseIds: ["tool_m"],
      openReader: () => reader,
      dbPath: tmpDb(),
    });
    expect(steps?.map((s) => s.kind)).toEqual(["thinking", "tool", "assistant"]);
    expect(steps?.find((s) => s.kind === "tool")).toMatchObject({ toolUseId: "tool_m" });
  });

  it("returns undefined when nothing anchors the turn", () => {
    const reader = buildReader(conv, [turnA, turnB]);
    const opts = { conversationId: conv, openReader: () => reader, dbPath: tmpDb() };
    expect(resolveTurnSteps({ ...opts, toolUseIds: ["tool_nope"] })).toBeUndefined();
    expect(resolveTurnSteps({ ...opts, toolUseIds: [] })).toBeUndefined();
  });
});
