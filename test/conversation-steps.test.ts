import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanFields, decodeStep, groupSteps, resolveTurnSteps } from "../src/conversation-steps.js";
import { openDbReader } from "../src/cursor-db.js";
import { HOOK_EVENT_PLACEMENT } from "../src/conversation-steps-constants.js";
import { enrichTurn, withTurnHooks } from "../src/turn-enrichment.js";
import type { Step } from "../src/models/conversation-steps.js";
import type { BlobReader } from "../src/models/cursor-db.js";
import type { Config } from "../src/models/config.js";
import type { TurnBuffer } from "../src/models/types.js";
import { tool, turn } from "./utils/state.js";

vi.mock("../src/cursor-db.js", () => ({ openDbReader: vi.fn() }));

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
function toolStep(toolField: number, toolUseId: string, ...hooks: Buffer[]): Buffer {
  const toolCall = Buffer.concat([
    lenField(toolField, str("args")),
    lenField(57, str(toolUseId)),
    ...hooks.map((hook) => lenField(54, hook)),
  ]);
  return lenField(2, toolCall);
}
function hookEntry(name?: string, output?: string): Buffer {
  return Buffer.concat([
    name ? lenField(1, str(name)) : str(""),
    output ? lenField(2, str(output)) : str(""),
  ]);
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
function buildReader(conversationId: string, turns: Buffer[][], users: Buffer[] = []): BlobReader {
  const store = new Map<string, Buffer>();
  const turnIds: Buffer[] = [];
  turns.forEach((steps, ti) => {
    const stepIdBufs: Buffer[] = [];
    steps.forEach((stepBlob, si) => {
      const stepId = str(`${conversationId}t${ti}s${si}`);
      store.set(`agentKv:blob:${stepId.toString("hex")}`, stepBlob);
      stepIdBufs.push(stepId);
    });
    const userId = str(`${conversationId}user${ti}`);
    if (users[ti]) store.set(`agentKv:blob:${userId.toString("hex")}`, users[ti]);
    const agent = Buffer.concat([
      users[ti] ? lenField(1, userId) : Buffer.alloc(0),
      ...stepIdBufs.map((id) => lenField(2, id)),
    ]);
    const turnId = str(`${conversationId}turn${ti}`);
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

  it("leaves a reply without tools unresolved even when the newest turn says the same", () => {
    const previous = [thinkingStep("Use option A", 1), assistantStep("Done.")];
    vi.mocked(openDbReader).mockReturnValue(buildReader(conv, [previous]));
    const buffer: TurnBuffer = {
      tracingMode: "full",
      generation_id: "gen-b",
      prompt: "again",
      model: "default",
      startMs: 0,
      thoughts: [],
      subagents: [],
      tools: [],
      finalText: "Done.",
    };
    const config = { cursorDbPath: tmpDb() } as Config;
    const enriched = enrichTurn(config, { buffer, conversationId: conv, turnNum: 2, project: "p" });
    expect(enriched.steps).toBeUndefined();
  });
});

describe("withTurnHooks", () => {
  const user = (generationId: string, ...hooks: Buffer[]) =>
    Buffer.concat([lenField(2, str(generationId)), ...hooks.map((h) => lenField(21, h))]);

  it("reads the hooks of the turn whose message id is the generation, placed by event, and none when muted or off", () => {
    const hook = (name: string, output = name) => ({ name, output });
    const entries = (...names: string[]) => names.map((name) => hookEntry(name, name));
    const reader = buildReader(
      "conv-1",
      [
        [
          toolStep(
            8,
            "tool_m",
            hookEntry("preToolUse", "pre"),
            hookEntry("postToolUse", "post"),
            ...entries("stop", "y"),
          ),
          toolStep(8, "tool_n", hookEntry("postToolUse"), hookEntry(undefined, "no name")),
        ],
        [],
      ],
      [
        user("gen-1", ...entries("beforeSubmitPrompt", "afterAgentResponse", "preToolUse", "x")),
        user("gen-2", hookEntry("beforeSubmitPrompt", "P2")),
      ],
    );
    vi.mocked(openDbReader).mockReturnValue(reader);
    const hooksFor = (tracingMode: "full" | "metadata", captureHookOutputs = true) =>
      withTurnHooks({ cursorDbPath: tmpDb(), captureHookOutputs } as Config, {
        buffer: turn("gen-1", 0, { tracingMode }),
        conversationId: "conv-1",
        turnNum: 1,
        project: "test",
      }).hooks;
    expect(hooksFor("full")).toEqual({
      inputs: [hook("beforeSubmitPrompt"), hook("preToolUse"), hook("x"), hook("y")],
      outputs: [hook("afterAgentResponse"), hook("stop")],
      tools: new Map([
        ["tool_m", { inputs: [hook("preToolUse", "pre")], outputs: [hook("postToolUse", "post")] }],
      ]),
    });
    expect(hooksFor("metadata")).toBeUndefined();
    expect(hooksFor("full", false)).toBeUndefined();
  });

  it("gives an id-less step's hooks to the turn's only id-less tool, and to none when ambiguous", () => {
    const hooksFor = (steps: number, tools: number) => {
      const idless = [...Array(steps).keys()].map((i) =>
        toolStep(1, "", hookEntry("postToolUse", `out${i}`)),
      );
      vi.mocked(openDbReader).mockReturnValue(buildReader("c", [idless], [user("g")]));
      const buffered = [...Array(tools).keys()].map((i) => tool(`cursor-call-g-${i}`, "Shell", 0));
      return withTurnHooks({ cursorDbPath: tmpDb(), captureHookOutputs: true } as Config, {
        buffer: turn("g", 0, { tracingMode: "full", tools: buffered }),
        conversationId: "c",
        turnNum: 1,
        project: "p",
      }).hooks?.tools.get("cursor-call-g-0");
    };
    expect(hooksFor(1, 1)).toEqual({
      inputs: [],
      outputs: [{ name: "postToolUse", output: "out0" }],
    });
    expect(hooksFor(2, 1)).toBeUndefined();
    expect(hooksFor(1, 2)).toBeUndefined();
  });

  it("reads only an unmuted subagent's own tool hooks from its newest turns, over the parent's reader", () => {
    const parent = buildReader("p", [[], []], [user("old"), user("g")]);
    const child = buildReader("child", [
      [toolStep(8, "s1", hookEntry("postToolUse", "old"))],
      [
        toolStep(8, "s1", hookEntry("postToolUse", "S1"), hookEntry("stop", "S1 stop")),
        toolStep(8, "", hookEntry("postToolUse", "id-less")),
        toolStep(8, "other", hookEntry("postToolUse", "other")),
      ],
    ]);
    const older = ["pturn0", "childturn0"].map((id) => `agentKv:blob:${str(id).toString("hex")}`);
    const get = (k: string) => {
      if (older.includes(k)) throw new Error(`read an older turn: ${k}`);
      return parent.get(k) ?? child.get(k);
    };
    const reader = { get, close: () => {} };
    vi.mocked(openDbReader).mockClear().mockReturnValue(reader);
    const hooksFor = (tracingMode: "full" | "metadata") => {
      const subagent = {
        subagent_id: "sa",
        subagent_type: "explore",
        task: "t",
        startMs: 0,
        tracingMode,
        childConversationId: "child",
        tools: [tool("s1", "Read", 0), tool("cursor-call-c-0", "Shell", 0)],
      };
      return withTurnHooks({ cursorDbPath: tmpDb(), captureHookOutputs: true } as Config, {
        buffer: turn("g", 0, { tracingMode: "full", subagents: [subagent] }),
        conversationId: "p",
        turnNum: 1,
        project: "p",
      }).hooks;
    };
    expect(hooksFor("full")).toEqual({
      inputs: [],
      outputs: [],
      tools: new Map([["s1", { inputs: [], outputs: [{ name: "postToolUse", output: "S1" }] }]]),
    });
    expect(hooksFor("metadata")?.tools).toEqual(new Map());
    expect(openDbReader).toHaveBeenCalledTimes(2);
  });
});

describe("HOOK_EVENT_PLACEMENT", () => {
  it("matches Cursor's documented hook events", () => {
    const rows = [...HOOK_EVENT_PLACEMENT].map(
      ([event, p]) => `${event} ${p.direction} ${p.scope}`,
    );
    expect(rows).toEqual([
      "sessionStart input turn",
      "sessionEnd output turn",
      "preToolUse input tool",
      "postToolUse output tool",
      "postToolUseFailure output tool",
      "subagentStart input turn",
      "subagentStop output turn",
      "beforeShellExecution input tool",
      "afterShellExecution output tool",
      "beforeMCPExecution input tool",
      "afterMCPExecution output tool",
      "beforeReadFile input tool",
      "afterFileEdit output tool",
      "beforeSubmitPrompt input turn",
      "preCompact input turn",
      "stop output turn",
      "afterAgentResponse output turn",
      "afterAgentThought output turn",
      "beforeTabFileRead input turn",
      "afterTabFileEdit output turn",
      "workspaceOpen input turn",
    ]);
  });
});
