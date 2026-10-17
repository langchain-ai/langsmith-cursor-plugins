import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  finishedJobRefs,
  jobRef,
  queuedContext,
  reduceQueued,
  reduceUploaded,
} from "../src/job-context.js";
import { reduceSubagentStop } from "../src/reducer.js";
import { saveTurnForUpload } from "../src/tracing-engine.js";
import { conversation, loadState, T0, testConfig, turn } from "./utils/state.js";

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
    kind: "stop",
    buffer: turn("g1", T0, { tracingMode, prompt: "PRIVATE_PROMPT" }),
    conversationId: "c1",
    turnNum: 1,
    origin: { project: "cursor" },
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
  it("settles once the turn is saved for the uploader", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ls-cursor-saved-"));
    expect(await upload(dir)).toBe(true);
    expect(savedText(join(dir, "langsmith_engine"))).toContain("cursor-job:");
    expect(loadState(join(dir, "state.json")).c1.queued?.g1?.buffer.prompt).toBe("PRIVATE_PROMPT");
  });

  it("stays unsettled when the traces cannot be saved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ls-cursor-unsaved-"));
    writeFileSync(join(dir, "langsmith_engine"), "not a directory");
    expect(await upload(dir)).toBe(false);
  });

  it("never writes a muted turn's content into the uploader's storage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ls-cursor-muted-"));
    expect(await upload(dir, "metadata")).toBe(true);
    expect(savedText(join(dir, "langsmith_engine"))).toContain("cursor-job:");
    expect(savedText(join(dir, "langsmith_engine"))).not.toContain("PRIVATE_PROMPT");
  });
});

describe("a queued turn's saved copy", () => {
  it("stays while its to-do is pending, so a retry can still build it", () => {
    const [done, waiting] = [1, 2].map((savedAtMs) =>
      jobRef({ conversationId: "c1", generationId: `g${savedAtMs}`, savedAtMs }),
    );
    const built = new Map([
      ["job-done", done],
      ["job-waiting", waiting],
    ]);
    expect(finishedJobRefs(built, new Set(["job-waiting"]))).toEqual([
      { conversationId: "c1", generationId: "g1", savedAtMs: 1 },
    ]);
  });

  it("leaves a newer copy of the same turn when an older to-do finishes", () => {
    const context = {
      kind: "sweep" as const,
      buffer: turn("g1", T0),
      conversationId: "c1",
      turnNum: 1,
      origin: { project: "cursor" },
    };
    const older = { conversationId: "c1", generationId: "g1", savedAtMs: 1 };
    const state = reduceQueued(reduceQueued({}, context, 1), { ...context, kind: "stop" }, 2);
    const after = reduceUploaded(state, [older]);
    expect(queuedContext(after, { ...older, savedAtMs: 2 })?.kind).toBe("stop");
  });

  it("keeps a subagent's own conversation while its turn waits for the uploader", () => {
    const queued = {
      kind: "stop" as const,
      buffer: turn("cg", T0),
      conversationId: "child",
      turnNum: 1,
      origin: { project: "cursor" },
      savedAtMs: T0,
    };
    const subagent = { subagent_id: "s1", subagent_type: "explore", task: "t", startMs: T0 };
    const state = {
      parent: conversation([turn("pg", T0, { subagents: [subagent] })]),
      child: conversation([], { turn_count: 1, queued: { cg: queued } }),
    };
    const input = {
      hook_event_name: "subagentStop",
      conversation_id: "parent",
      generation_id: "pg",
      model: "default",
      subagent_id: "s1",
      subagent_type: "explore",
    } as const;
    const resolved = { childConversationId: "child", toolCalls: [], resultText: "" };
    const after = reduceSubagentStop(state, input, T0 + 1000, resolved);
    expect(after.child?.queued?.cg).toBeDefined();
  });
});
