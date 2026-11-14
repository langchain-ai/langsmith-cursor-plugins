import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HookNote, RunPatch, RunPost } from "@langchain/plugins-base/tracer";
import { buildTurnRuns, turnRunId } from "../src/langsmith.js";
import { createTranscriptBuilder } from "../src/tracer-builder.js";
import { setThreadTracingMode } from "../src/tracing-policy.js";
import type { BuilderSettings, CursorHookInput } from "../src/models/tracer-builder.js";
import { MINUTE, T0 } from "./utils/state.js";
import { replayHookLog } from "./utils/replay.js";

vi.mock("../src/attachments.js", () => ({
  resolveTurnAttachments: () => [{ type: "text", text: "ATTACHED" }],
}));

const CAPTURE = join(process.cwd(), "test/fixtures/cursor-hooks.jsonl");
const PARENT_CONV = "6bd3db3e-e838-485e-befc-b5f0d05b18cd";
const SETTINGS: BuilderSettings = {
  attachmentsEnabled: false,
  systemPromptEnabled: false,
  cursorDbPath: join(process.cwd(), "test/fixtures/missing.vscdb"),
  captureHookOutputs: false,
  defaultMuted: false,
  locked: [],
  sweepIdleMinutes: 360,
  stateFilePath: join(process.cwd(), "test/fixtures/missing-state.json"),
  cwd: "/repo",
};

function fakeBuilder(settings = SETTINGS, savedState?: unknown) {
  const posts: RunPost[] = [];
  const patches: RunPatch[] = [];
  const sink = { post: (run: RunPost) => posts.push(run), patch: (p: RunPatch) => patches.push(p) };
  const builder = createTranscriptBuilder({ sessionId: "/repo", savedState, sink });
  const send = (
    input: Partial<CursorHookInput>,
    time: number,
    tracingMode?: HookNote["tracingMode"],
  ) =>
    builder.receiveNote({
      integration: "cursor",
      event: input.hook_event_name!,
      sessionId: "/repo",
      tracingMode,
      details: { input, time, origin: { project: "p" }, settings },
      writer: { destinations: [] },
    } as HookNote);
  return { builder, posts, patches, send };
}

const turnInputs = (generation_id: string, conversation_id = "c1") => ({
  conversation_id,
  generation_id,
  model: "claude-4.6-sonnet",
});
const prompt = (gen: string) =>
  ({ ...turnInputs(gen), hook_event_name: "beforeSubmitPrompt", prompt: "hi" }) as const;
const tool = (gen: string, id: string) =>
  ({
    ...turnInputs(gen),
    hook_event_name: "postToolUse",
    tool_name: "Read",
    tool_input: { path: "/repo/a.ts" },
    tool_output: "{}",
    tool_use_id: id,
  }) as const;
const stop = (gen: string) =>
  ({ ...turnInputs(gen), hook_event_name: "stop", status: "completed" }) as const;

describe("Cursor transcript builder", () => {
  it("posts each run of a captured session once with today's ids", () => {
    const { posts, send } = fakeBuilder();
    const lines = readFileSync(CAPTURE, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      const { ts, payload } = JSON.parse(line) as { ts: string; payload: CursorHookInput };
      send(
        payload,
        Date.parse(ts),
        payload.hook_event_name === "beforeSubmitPrompt" ? "full" : undefined,
      );
    }

    const today = replayHookLog(CAPTURE).finalized.flatMap((turn) =>
      buildTurnRuns({ ...turn, buffer: { ...turn.buffer, tracingMode: "full" }, project: "p" }),
    );
    const ids = posts.map((run) => run.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(today.map(({ run }) => run.id).sort());
    expect(ids.length).toBe(55);
    const subagent = posts.find((run) => run.name === "explore Subagent")!;
    expect(
      posts.filter((run) => run.parent_run_id === subagent.id && run.run_type === "tool").length,
    ).toBe(35);
    expect(subagent.trace_id).toBe(turnRunId(PARENT_CONV, "5d28c524-8794-423c-97b8-395d7bc1492c"));
  });

  it("posts a tool when it finishes and closes the root with one patch after a restart", () => {
    const first = fakeBuilder();
    first.send(prompt("g1"), T0, "full");
    first.send(tool("g1", "t1"), T0 + 1_000);
    expect(first.posts.map((run) => [run.run_type, run.end_time === undefined])).toEqual([
      ["chain", true],
      ["tool", false],
    ]);

    const saved = JSON.parse(JSON.stringify(first.builder.state()));
    const second = fakeBuilder(SETTINGS, saved);
    second.send(stop("g1"), T0 + 2_000);
    expect(second.posts.map((run) => run.run_type).sort()).toEqual(["llm", "llm"]);
    expect(second.patches).toHaveLength(1);
    expect(second.patches[0]).toMatchObject({
      id: turnRunId("c1", "g1"),
      end_time: expect.any(String),
    });
  });

  it("puts the prompt's attachments on the root its first tool posts", () => {
    const { posts, send } = fakeBuilder({ ...SETTINGS, attachmentsEnabled: true });
    send(prompt("g1"), T0, "full");
    send(tool("g1", "t1"), T0 + 1_000);
    send(tool("g1", "t2"), T0 + 2_000);

    expect(posts.map((run) => run.run_type)).toEqual(["chain", "tool", "tool"]);
    expect(JSON.stringify(posts[0].inputs)).toContain("ATTACHED");
  });

  it("waits for stop to post tools when hook outputs are captured", () => {
    const { posts, send } = fakeBuilder({ ...SETTINGS, captureHookOutputs: true });
    send(prompt("g1"), T0, "full");
    send(tool("g1", "t1"), T0 + 1_000);
    expect(posts).toEqual([]);
    send(stop("g1"), T0 + 2_000);
    expect(posts.map((run) => run.run_type).sort()).toEqual(["chain", "llm", "llm", "tool"]);
  });

  it("uploads a turn left without a stop once another conversation passes the idle time", async () => {
    const privacy = join(mkdtempSync(join(tmpdir(), "builder privacy ")), "privacy.json");
    vi.stubEnv("LANGSMITH_CURSOR_PRIVACY_FILE", privacy);
    const { posts, patches, send } = fakeBuilder();
    send(prompt("g1"), T0, "full");
    send(tool("g1", "t1"), T0 + 1_000);
    await setThreadTracingMode(privacy, "c1", "metadata");
    send({ ...prompt("g2"), conversation_id: "c2" }, T0 + 361 * MINUTE, "full");
    vi.unstubAllEnvs();

    expect(posts.map((run) => run.run_type).sort()).toEqual(["chain", "llm", "llm", "tool"]);
    expect(posts.filter((run) => run.run_type === "llm").map((run) => run.tracingMode)).toEqual([
      "metadata",
      "metadata",
    ]);
    expect(patches).toEqual([
      expect.objectContaining({ id: turnRunId("c1", "g1"), error: "incomplete" }),
    ]);
  });

  it("does not patch a closed root again when a late tool reopens its swept turn", () => {
    const { posts, patches, send } = fakeBuilder();
    send(prompt("g1"), T0, "full");
    send({ ...prompt("g2"), conversation_id: "c2" }, T0 + 361 * MINUTE, "full");
    expect(posts.map((run) => [run.run_type, run.end_time !== undefined])).toEqual([
      ["chain", true],
      ["llm", true],
    ]);
    send(tool("g1", "t1"), T0 + 362 * MINUTE);
    send(stop("g1"), T0 + 363 * MINUTE);

    expect(posts.map((run) => run.run_type).sort()).toEqual(["chain", "llm", "llm", "llm", "tool"]);
    expect(patches).toEqual([]);
  });

  it("keeps a locked mute and skips a turn that started off", () => {
    const locked = { ...SETTINGS, defaultMuted: true, locked: ["defaultMuted" as const] };
    const { posts, send } = fakeBuilder(locked);
    send(prompt("g1"), T0, "full");
    send(tool("g1", "t1"), T0 + 500);
    send(stop("g1"), T0 + 1_000);
    send(prompt("g2"), T0 + 2_000, "off");
    send(tool("g2", "t2"), T0 + 3_000);
    send(stop("g2"), T0 + 4_000);

    expect(posts.length).toBe(4);
    expect(posts.every((run) => run.tracingMode === "metadata")).toBe(true);
  });
});
