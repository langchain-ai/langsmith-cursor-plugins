import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { createCaptureStore } from "@langchain/plugins-base/storage/capture";
import { createLangSmithUploadWriter } from "@langchain/plugins-base/tracing/upload";
import {
  reduceAfterAgentResponse,
  reducePostToolUse,
  reduceStop,
  reduceSubagentStop,
  reduceSweep,
  reduceUploadSettled,
} from "../src/reducer.js";
import { DEFAULT_SWEEP_IDLE_MINUTES, MAX_UPLOAD_ATTEMPTS } from "../src/constants.js";
import * as logger from "../src/logger.js";
import { runSweep } from "../src/sweep.js";
import { loadState, saveState } from "../src/state.js";
import { loadConfig, type Config } from "../src/config.js";
import { MUTED_TRACE_CONTENT } from "../src/privacy.js";
import { initTracing, buildTurnRuns } from "../src/langsmith.js";
import { replayHookLog } from "./utils/replay.js";
import { mockClient } from "./utils/mock_client.js";
import { getAssumedTreeFromCalls } from "./utils/tree.js";
import { withWindowsProcessEnvironment } from "./utils/process-environment.js";
import type { SweepHttpUpload } from "./models/sweep.js";
import { HOUR, MINUTE, T0, conversation, tool, turn } from "./utils/state.js";
import type {
  AfterAgentResponseInput,
  ConversationState,
  HookInputBase,
  PostToolUseInput,
  SubagentStopInput,
  TracingState,
  TurnBuffer,
} from "../src/types.js";

const THRESHOLD = HOUR;
const CALLER = "caller-conversation";
const CALLER_INPUT = {
  hook_event_name: "postToolUse",
  conversation_id: CALLER,
  generation_id: "gcaller",
  model: "default",
} satisfies HookInputBase;

const HEADLESS = join(process.cwd(), "test/fixtures/cursor-headless.jsonl");
const HEADLESS_CONV = "9f2c1d04-7a55-4b1e-9d3c-2e8b6f41ac07";
const HEADLESS_GEN = "b7e41c92-3f08-4a6d-8c15-5d90a2f7be31";
const HEADLESS_LAST_MS = Date.parse("2026-08-14T09:12:11.264Z");
const HEADLESS_TOOLS = 3;
const FINAL_SWEEP = {
  finalSweep: {
    nowMs: HEADLESS_LAST_MS + DEFAULT_SWEEP_IDLE_MINUTES * MINUTE + MINUTE,
    callerConversationId: CALLER,
  },
};

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function runHook(
  entry: string,
  input: Record<string, unknown>,
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd,
      env,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Hook timed out"));
    }, 20_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`hook exited ${code}: ${stderr}`));
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function stranded(): TracingState {
  return { c1: conversation([turn("g1", T0)]) };
}

function stopInput(conversationId: string, generationId: string) {
  return {
    hook_event_name: "stop",
    conversation_id: conversationId,
    generation_id: generationId,
    model: "default",
  } as const;
}

function responseInput(generationId: string, text: string): AfterAgentResponseInput {
  return {
    hook_event_name: "afterAgentResponse",
    conversation_id: "c1",
    generation_id: generationId,
    model: "default",
    text,
  };
}

function toolInput(generationId: string, toolUseId: string): PostToolUseInput {
  return {
    hook_event_name: "postToolUse",
    conversation_id: "c1",
    generation_id: generationId,
    model: "default",
    tool_name: "Read",
    tool_input: {},
    tool_output: "{}",
    tool_use_id: toolUseId,
  };
}

function subagentParent(endMs?: number): ConversationState {
  const subagent = { subagent_id: "s1", subagent_type: "explore", task: "go", startMs: T0, endMs };
  return conversation([turn("gp", T0, { tracingMode: "full", subagents: [subagent] })], {
    turn_count: 4,
  });
}

function parentAndChild(endMs?: number): TracingState {
  return {
    parent: subagentParent(endMs),
    child: conversation([turn("gc", T0, { tools: [tool("t1", "Grep", T0)] })]),
  };
}

function stopSubagent(state: TracingState, childConversationId: string): TracingState {
  const input: SubagentStopInput = {
    hook_event_name: "subagentStop",
    conversation_id: "parent",
    generation_id: "gp",
    model: "default",
    subagent_id: "s1",
    subagent_type: "explore",
  };
  return reduceSubagentStop(state, input, T0 + MINUTE, { childConversationId });
}

describe("reduceSweep abandonment threshold", () => {
  it("claims a turn once it has been idle for the whole threshold", () => {
    expect(reduceSweep(stranded(), CALLER, T0 + THRESHOLD - 1, THRESHOLD).claims).toEqual([]);

    const result = reduceSweep(stranded(), CALLER, T0 + THRESHOLD, THRESHOLD);
    expect(result.claims.map((c) => c.generationId)).toEqual(["g1"]);
    expect(result.claims[0].turnNum).toBe(1);
    expect(result.state.c1.turns).toEqual({});
    expect(result.state.c1.turn_count).toBe(1);
  });

  it("measures idleness from the turn's own events, not conversation churn", () => {
    const state: TracingState = {
      c1: conversation([turn("g1", T0, { tools: [tool("t1", "Read", T0 + 30 * MINUTE)] })], {
        updated: new Date(T0 + 3 * HOUR).toISOString(),
      }),
    };
    expect(reduceSweep(state, CALLER, T0 + 80 * MINUTE, THRESHOLD).claims).toEqual([]);
    expect(reduceSweep(state, CALLER, T0 + 95 * MINUTE, THRESHOLD).claims.length).toBe(1);
  });

  it("counts the arrival of the final response as activity", () => {
    const text = "streamed after 70 minutes of thinking";
    const state = reduceAfterAgentResponse(stranded(), responseInput("g1", text), T0 + 70 * MINUTE);
    expect(state.c1.turns.g1.finalTextArrivedMs).toBe(T0 + 70 * MINUTE);
    expect(reduceSweep(state, CALLER, T0 + 2 * HOUR, THRESHOLD).claims).toEqual([]);
    expect(reduceSweep(state, CALLER, T0 + 3 * HOUR, THRESHOLD).claims.length).toBe(1);
  });

  it("drops a muted-off turn without claiming it", () => {
    const state: TracingState = { c1: conversation([turn("g1", T0, { tracingMode: "off" })]) };
    const result = reduceSweep(state, CALLER, T0 + 2 * HOUR, THRESHOLD);
    expect(result.claims).toEqual([]);
    expect(result.state.c1.turns).toEqual({});
    expect(result.state.c1.completedOffGenerations).toEqual(["g1"]);
    expect(result.state.c1.pending).toBeUndefined();
  });
});

describe("reduceSweep exclusions", () => {
  it("never sweeps the conversation whose hook is running", () => {
    const result = reduceSweep(stranded(), "c1", T0 + 5 * HOUR, THRESHOLD);
    expect(result.claims).toEqual([]);
    expect(Object.keys(result.state.c1.turns)).toEqual(["g1"]);
  });

  it("shields a subagent's own thread until the subagent finishes", () => {
    const threads = (endMs?: number): TracingState => ({
      ...parentAndChild(endMs),
      headless: conversation([turn("gh", T0, { tools: [tool("t2", "Bash", T0)] })]),
    });

    const open = reduceSweep(threads(), CALLER, T0 + 5 * HOUR, THRESHOLD);
    expect(open.claims.map((c) => c.conversationId)).toEqual(["headless"]);
    expect(Object.keys(open.state.child.turns)).toEqual(["gc"]);

    const done = reduceSweep(threads(T0 + MINUTE), CALLER, T0 + 5 * HOUR, THRESHOLD);
    expect(done.claims.map((c) => c.conversationId).sort()).toEqual([
      "child",
      "headless",
      "parent",
    ]);
    expect(done.claims.find((c) => c.conversationId === "parent")!.turnNum).toBe(5);
  });

  it("still shields the child once the parent's turn is pending", () => {
    const stopped = reduceStop(parentAndChild(), stopInput("parent", "gp"), T0 + MINUTE).state;
    expect(stopped.parent.turns).toEqual({});
    expect(stopped.parent.pending!.gp.buffer.subagents[0].endMs).toBeUndefined();

    const result = reduceSweep(stopped, CALLER, T0 + 5 * HOUR, THRESHOLD);
    expect(result.claims.map((c) => c.conversationId)).toEqual(["parent"]);
    expect(Object.keys(result.state.child.turns)).toEqual(["gc"]);
  });
});

describe("reduceSubagentStop absorbing the child conversation", () => {
  it("keeps the child's pending upload instead of deleting it", () => {
    const next = stopSubagent(
      {
        parent: subagentParent(),
        child: conversation([], {
          turn_count: 1,
          pending: { gc: { buffer: turn("gc", T0), turnNum: 1, claimedAt: T0, attempts: 1 } },
        }),
      },
      "child",
    );
    expect(next.parent.turns.gp.subagents[0].childConversationId).toBe("child");
    expect(next.child.pending!.gc.turnNum).toBe(1);
    expect(next.child.turns).toEqual({});
  });

  it("never consumes the parent's own thread when the child id points back at it", () => {
    const next = stopSubagent({ parent: subagentParent() }, "parent");
    expect(Object.keys(next.parent.turns)).toEqual(["gp"]);
    expect(next.parent.turns.gp.subagents[0].childConversationId).toBeUndefined();
  });
});

describe("reduceSweep claims are exactly once", () => {
  it("leaves a pending entry alone when a later claim replaced the one being settled", () => {
    const first = reduceSweep(stranded(), CALLER, T0 + 2 * HOUR, THRESHOLD);
    const reclaimed = reduceSweep(first.state, CALLER, T0 + 4 * HOUR, THRESHOLD);

    const stale = reduceUploadSettled(reclaimed.state, "c1", "g1", T0 + 2 * HOUR);
    expect(stale.c1.pending!.g1).toMatchObject({ attempts: 2, claimedAt: T0 + 4 * HOUR });

    const settled = reduceUploadSettled(stale, "c1", "g1", T0 + 4 * HOUR);
    expect(settled.c1.pending).toBeUndefined();
  });

  it("restarts the retry clock on each re-claim, then gives up at the attempt cap", () => {
    const spy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const first = reduceSweep(stranded(), CALLER, T0 + 2 * HOUR, THRESHOLD);

    const retried = reduceSweep(first.state, CALLER, T0 + 4 * HOUR, THRESHOLD);
    expect(retried.claims.map((c) => c.generationId)).toEqual(["g1"]);
    expect(retried.state.c1.pending!.g1).toMatchObject({ attempts: 2, claimedAt: T0 + 4 * HOUR });

    const tooSoon = reduceSweep(retried.state, CALLER, T0 + 4 * HOUR + MINUTE, THRESHOLD);
    expect(tooSoon.claims).toEqual([]);
    expect(tooSoon.state.c1.turn_count).toBe(1);

    const last = reduceSweep(tooSoon.state, CALLER, T0 + 6 * HOUR, THRESHOLD);
    expect(last.state.c1.pending!.g1.attempts).toBe(MAX_UPLOAD_ATTEMPTS);

    const dropped = reduceSweep(last.state, CALLER, T0 + 8 * HOUR, THRESHOLD);
    expect(dropped.claims).toEqual([]);
    expect(dropped.state.c1.pending).toBeUndefined();
    expect(dropped.state.c1.turns).toEqual({});
    expect(spy).toHaveBeenCalledWith(
      `Dropping turn 1 of conversation c1 after ${MAX_UPLOAD_ATTEMPTS} failed upload attempts`,
    );
    spy.mockRestore();
  });
});

describe("late hooks for a finalized generation", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("reopens the turn for a late response, then lets the real stop supersede it", () => {
    const swept = reduceSweep(stranded(), CALLER, T0 + 2 * HOUR, THRESHOLD);
    expect(swept.claims[0]).toMatchObject({ turnNum: 1 });
    expect(swept.claims[0].buffer.status).toBe("incomplete");
    expect(swept.state.c1.sweepFinalizedGenerations).toEqual(["g1"]);

    const answer = responseInput("g1", "the real answer");
    const late = reduceAfterAgentResponse(swept.state, answer, T0 + 3 * HOUR);
    expect(late.c1.turns.g1).toMatchObject({ turnNum: 1, finalText: "the real answer" });
    expect(late.c1.pending).toBeUndefined();
    expect(late.c1.sweepFinalizedGenerations).toEqual(["g1"]);
    expect(spy).toHaveBeenCalledWith(
      "Sweep recovered conversation c1 generation g1 too early; reopening it for a late afterAgentResponse",
    );

    const done = { ...stopInput("c1", "g1"), status: "completed" };
    const stopped = reduceStop(late, done, T0 + 3 * HOUR + MINUTE);
    expect(stopped.turnNum).toBe(1);
    expect(stopped.buffer?.status).toBe("completed");
    expect(stopped.buffer?.finalText).toBe("the real answer");
    expect(stopped.state.c1.pending?.g1).toMatchObject({ turnNum: 1, attempts: 1 });
    expect(stopped.state.c1.stopFinalizedGenerations).toEqual(["g1"]);
    expect(stopped.state.c1.sweepFinalizedGenerations).toBeUndefined();
    expect(stopped.state.c1.turns).toEqual({});
    expect(stopped.state.c1.turn_count).toBe(1);
  });

  it("lets a stop alone supersede the sweep when no other event arrives first", () => {
    const swept = reduceSweep(stranded(), CALLER, T0 + 2 * HOUR, THRESHOLD).state;
    const stopped = reduceStop(
      swept,
      { ...stopInput("c1", "g1"), status: "completed" },
      T0 + 3 * HOUR,
    );

    expect(stopped.turnNum).toBe(1);
    expect(stopped.buffer?.status).toBe("completed");
    expect(stopped.state.c1.sweepFinalizedGenerations).toBeUndefined();
  });

  it("leaves a turn the sweep never touched alone", () => {
    const state: TracingState = { c1: conversation([turn("g1", T0, { turnNum: 1 })]) };
    const stopped = reduceStop(state, stopInput("c1", "g1"), T0 + MINUTE).state;

    const second = reduceStop(stopped, stopInput("c1", "g1"), T0 + 2 * MINUTE);
    expect(second.buffer).toBeUndefined();
    expect(second.turnNum).toBe(0);
    expect(stopped.c1.pending?.g1).toMatchObject({ turnNum: 1 });
  });

  it("drops the event silently after a normal stop", () => {
    const state: TracingState = { c1: conversation([turn("g1", T0, { tracingMode: "full" })]) };
    const stopped = reduceStop(state, stopInput("c1", "g1"), T0 + MINUTE).state;
    expect(stopped.c1.sweepFinalizedGenerations).toBeUndefined();
    expect(stopped.c1.stopFinalizedGenerations).toEqual(["g1"]);

    expect(reducePostToolUse(stopped, toolInput("g1", "late"), T0 + 2 * MINUTE)).toBe(stopped);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("a generation is buffered or pending, never both", () => {
  function whereIsIt(state: TracingState, generationId: string): string[] {
    const conv = state.c1;
    const places: string[] = [];
    if (Object.hasOwn(conv.turns, generationId)) places.push("turns");
    if (conv.pending && Object.hasOwn(conv.pending, generationId)) places.push("pending");
    return places;
  }

  it("holds in one place at every step of a sweep the stop later supersedes", () => {
    const buffered: TracingState = { c1: conversation([turn("g1", T0, { tracingMode: "full" })]) };
    expect(whereIsIt(buffered, "g1")).toEqual(["turns"]);

    const swept = reduceSweep(buffered, CALLER, T0 + 2 * HOUR, THRESHOLD).state;
    expect(whereIsIt(swept, "g1")).toEqual(["pending"]);

    const settled = reduceUploadSettled(swept, "c1", "g1", T0 + 2 * HOUR);
    expect(whereIsIt(settled, "g1")).toEqual(["turns"]);

    const stopped = reduceStop(settled, stopInput("c1", "g1"), T0 + 3 * HOUR).state;
    expect(whereIsIt(stopped, "g1")).toEqual(["pending"]);

    const done = reduceUploadSettled(stopped, "c1", "g1", T0 + 3 * HOUR);
    expect(whereIsIt(done, "g1")).toEqual([]);
    expect(done.c1.turn_count).toBe(1);
  });

  it("counts a turn once even when a late event sends it back through the sweep", () => {
    const swept = reduceSweep(stranded(), CALLER, T0 + 2 * HOUR, THRESHOLD).state;
    const settled = reduceUploadSettled(swept, "c1", "g1", T0 + 2 * HOUR);
    expect(settled.c1.turn_count).toBe(1);

    const late = reducePostToolUse(settled, toolInput("g1", "late"), T0 + 3 * HOUR);
    const reswept = reduceSweep(late, CALLER, T0 + 5 * HOUR, THRESHOLD);

    expect(reswept.claims.map((c) => c.generationId)).toEqual(["g1"]);
    expect(reswept.state.c1.turn_count).toBe(1);
    expect(whereIsIt(reswept.state, "g1")).toEqual(["pending"]);
  });
});

describe("headless cursor-agent run recovered by the sweep", () => {
  it("recovers as turn 1 a turn that no stop ever finalizes", () => {
    const live = replayHookLog(HEADLESS);
    expect(live.finalized).toEqual([]);
    expect(live.swept).toEqual([]);
    expect(live.finalState[HEADLESS_CONV].turns[HEADLESS_GEN].tools.length).toBe(HEADLESS_TOOLS);

    const { swept, finalState } = replayHookLog(HEADLESS, FINAL_SWEEP);
    expect(swept.length).toBe(1);
    expect(swept[0]).toMatchObject({ conversationId: HEADLESS_CONV, turnNum: 1 });
    expect(swept[0].buffer.status).toBe("incomplete");
    expect(finalState[HEADLESS_CONV].turns).toEqual({});
    expect(finalState[HEADLESS_CONV].turn_count).toBe(1);
  });

  it("builds a complete run tree from the recovered turn", async () => {
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, true, undefined, client);
    await buildTurnRuns({
      buffer: recoveredBuffer(),
      conversationId: HEADLESS_CONV,
      turnNum: 1,
      project: "cursor",
    });

    const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
    const names = tree.nodes.map((n) => n.split(":")[0]);
    expect(names).toEqual(expect.arrayContaining(["Cursor Turn 1", "Read", "Grep", "Bash"]));

    const root = Object.entries(tree.data).find(([id]) => id.startsWith("Cursor Turn 1:"))![1];
    expect(root.error).toBe("incomplete");
  });
});

describe("runSweep against the on-disk state file", () => {
  let dir: string;
  let stateFilePath: string;
  let home: string;
  let workspace: string;
  let endpoint: string;
  let config: Config;
  let server: ReturnType<typeof createServer>;
  let uploads: SweepHttpUpload[];
  const apiKey = "synthetic-sweep-test-key";
  const workerEntry = join(process.cwd(), "bundle/stop.js");

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "sweep-state-"));
    stateFilePath = join(dir, "langsmith-state.json");
    home = join(dir, "home");
    workspace = join(dir, "workspace");
    mkdirSync(home);
    mkdirSync(workspace);
    uploads = [];
    server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      const raw = await readRequestBody(request);
      if (request.method !== "GET" && request.method !== "HEAD") {
        const payload = (raw ? JSON.parse(raw) : {}) as SweepHttpUpload["payload"];
        uploads.push({
          action: request.method === "POST" ? "post" : "patch",
          runId: typeof payload.id === "string" ? payload.id : undefined,
          payload,
        });
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        request.method === "GET" && request.url?.endsWith("/info")
          ? JSON.stringify({ batch_ingest_config: { use_multipart_endpoint: false } })
          : "{}",
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Upload server did not start");
    endpoint = `http://127.0.0.1:${address.port}`;
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("TEMP", dir);
    vi.stubEnv("TMP", dir);
    vi.stubEnv("TMPDIR", dir);
    vi.stubEnv("TRACE_TO_LANGSMITH", "true");
    vi.stubEnv("LANGSMITH_CURSOR_API_KEY", apiKey);
    vi.stubEnv("LANGSMITH_CURSOR_ENDPOINT", endpoint);
    vi.stubEnv("LANGSMITH_CURSOR_PROJECT", "cursor");
    vi.stubEnv("LANGSMITH_CURSOR_STATE_FILE", stateFilePath);
    vi.stubEnv("LANGSMITH_CURSOR_PRIVACY_FILE", join(dir, "absent-privacy.json"));
    vi.stubEnv("LANGSMITH_CURSOR_LOG_FILE", join(dir, "hook.log"));
    vi.stubEnv("LANGSMITH_CURSOR_ATTACHMENTS", "false");
    vi.stubEnv("LANGSMITH_CURSOR_SYSTEM_PROMPT", "false");
    vi.stubEnv("LANGSMITH_CURSOR_REDACT_EXTRA", "[]");
    vi.stubEnv("LANGSMITH_CURSOR_SWEEP_IDLE_MINUTES", String(THRESHOLD / MINUTE));
    config = loadConfig({ cwd: workspace });
    saveState(stateFilePath, {
      c1: conversation([
        turn("g1", T0, {
          prompt: "recover me",
          tools: [tool("t1", "Read", T0, { path: "a.ts" })],
        }),
      ]),
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function runSweepWithWorkerEntry(options: Parameters<typeof runSweep>[0]) {
    const originalEntry = process.argv[1];
    process.argv[1] = workerEntry;
    try {
      return await runSweep(options);
    } finally {
      if (originalEntry === undefined) process.argv.splice(1, 1);
      else process.argv[1] = originalEntry;
    }
  }

  async function waitForDeliveredCaptures(
    sessionId: string,
    turnId: string,
    project: string,
  ): Promise<void> {
    const store = createCaptureStore(dir);
    const writer = createLangSmithUploadWriter({
      destinations: [{ apiKey, apiUrl: endpoint, projectName: project }],
      redact: true,
      redactExtraRules: [],
    });
    const destinationId = writer.destinations[0]!.id;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const records = (await store.enumerate("cursor", sessionId)).filter(
        ({ record }) => record.turnId === turnId,
      );
      const outcomes = await Promise.all(
        records.map(({ record }) =>
          store.readOutcome(
            {
              integration: record.integration,
              sessionId: record.sessionId,
              turnId: record.turnId,
              eventId: record.eventId,
            },
            destinationId,
          ),
        ),
      );
      if (
        outcomes.some(
          (outcome) => outcome.status === "settled" && outcome.receipt.outcome !== "delivered",
        )
      ) {
        throw new Error("A captured sweep run failed delivery");
      }
      if (records.length > 0 && outcomes.every((outcome) => outcome.status === "settled")) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Sweep capture receipts did not settle");
  }

  function workspaceInput() {
    return { ...CALLER_INPUT, workspace_roots: [workspace] };
  }

  it("uploads a claimed turn once, under the same lock as the calling hook", async () => {
    const uploaded = await runSweepWithWorkerEntry({
      config,
      input: workspaceInput(),
      nowMs: T0 + 2 * HOUR,
      apply: (state) => ({ ...state, c2: conversation([turn("g2", T0 + 2 * HOUR)]) }),
    });

    expect(uploaded.map((c) => c.generationId)).toEqual(["g1"]);
    const after = loadState(stateFilePath);
    expect(after.c1.turn_count).toBe(1);
    expect(after.c1.pending).toBeUndefined();
    expect(Object.keys(after.c2.turns)).toEqual(["g2"]);

    await waitForDeliveredCaptures("c1", "g1", "cursor");
    expect(JSON.stringify(uploads)).toContain("recover me");
    expect(JSON.stringify(uploads)).not.toContain(MUTED_TRACE_CONTENT);
    const uploadCount = uploads.length;

    const second = await runSweepWithWorkerEntry({
      config,
      input: workspaceInput(),
      nowMs: T0 + 2 * HOUR + MINUTE,
    });
    expect(second).toEqual([]);
    expect(uploads).toHaveLength(uploadCount);
  });

  it("routes a swept turn to the project saved with the turn", async () => {
    saveState(stateFilePath, {
      c1: conversation([
        turn("g1", T0, {
          tracingMode: "full",
          origin: { project: "the-turns-project", customMetadata: { cwd: "/repo/the-turn" } },
        }),
      ]),
    });
    await runSweepWithWorkerEntry({
      config: {
        ...config,
        project: "the-sweepers-project",
        customMetadata: { cwd: "/repo/sweep" },
      },
      input: workspaceInput(),
      nowMs: T0 + 2 * HOUR,
    });
    await waitForDeliveredCaptures("c1", "g1", "the-turns-project");
    const posted = uploads.filter((upload) => upload.action === "post");
    expect(posted.length).toBeGreaterThan(0);
    expect([...new Set(posted.map((upload) => upload.payload.session_name))]).toEqual([
      "the-turns-project",
    ]);
    expect([...new Set(posted.map((upload) => upload.payload.extra?.metadata?.cwd))]).toEqual([
      "/repo/the-turn",
    ]);
  });

  async function sweptTurnInputs(): Promise<string> {
    await runSweepWithWorkerEntry({ config, input: workspaceInput(), nowMs: T0 + 2 * HOUR });
    await waitForDeliveredCaptures("c1", "g1", "cursor");
    const records = await createCaptureStore(dir).enumerate("cursor", "c1");
    const turnRecords = records.filter(({ record }) => record.turnId === "g1");
    expect(turnRecords.length).toBeGreaterThan(0);
    expect(JSON.stringify(turnRecords)).toContain(MUTED_TRACE_CONTENT);
    expect(JSON.stringify(turnRecords)).not.toContain("recover me");
    return JSON.stringify(uploads);
  }

  it("uploads a muted thread's recovered turn without content", async () => {
    writeFileSync(
      process.env.LANGSMITH_CURSOR_PRIVACY_FILE!,
      JSON.stringify({ threads: { c1: "metadata" } }),
    );

    const inputs = await sweptTurnInputs();
    expect(inputs).toContain(MUTED_TRACE_CONTENT);
    expect(inputs).not.toContain("recover me");
  });

  it("keeps a turn muted at launch muted even when the thread is not", async () => {
    saveState(stateFilePath, {
      c1: conversation([turn("g1", T0, { tracingMode: "metadata", prompt: "recover me" })]),
    });

    const inputs = await sweptTurnInputs();
    expect(inputs).toContain(MUTED_TRACE_CONTENT);
    expect(inputs).not.toContain("recover me");
  });

  it("keeps a saved turn project when Stop runs after the project setting changes", async () => {
    saveState(stateFilePath, {
      c1: conversation([
        turn("g1", T0, {
          tracingMode: "full",
          prompt: "stop-origin-marker",
          origin: { project: "the-turns-project", customMetadata: { cwd: "/repo/the-turn" } },
        }),
      ]),
    });
    vi.stubEnv("LANGSMITH_CURSOR_PROJECT", "the-sweepers-project");
    const env = withWindowsProcessEnvironment({
      HOME: home,
      USERPROFILE: home,
      TMP: dir,
      TEMP: dir,
      TMPDIR: dir,
      LANG: "C.UTF-8",
      TRACE_TO_LANGSMITH: "true",
      LANGSMITH_CURSOR_API_KEY: apiKey,
      LANGSMITH_CURSOR_ENDPOINT: endpoint,
      LANGSMITH_CURSOR_PROJECT: "the-sweepers-project",
      LANGSMITH_CURSOR_STATE_FILE: stateFilePath,
      LANGSMITH_CURSOR_PRIVACY_FILE: join(dir, "absent-privacy.json"),
      LANGSMITH_CURSOR_LOG_FILE: join(dir, "stop-hook.log"),
      LANGSMITH_CURSOR_ATTACHMENTS: "false",
      LANGSMITH_CURSOR_SYSTEM_PROMPT: "false",
      LANGSMITH_CURSOR_REDACT_EXTRA: "[]",
    });
    await runHook(
      workerEntry,
      {
        hook_event_name: "stop",
        conversation_id: "c1",
        session_id: "c1",
        generation_id: "g1",
        model: "default",
        status: "completed",
        workspace_roots: [workspace],
      },
      workspace,
      env,
    );
    await waitForDeliveredCaptures("c1", "g1", "the-turns-project");
    const records = await createCaptureStore(dir).enumerate("cursor", "c1");
    expect(JSON.stringify(records)).not.toContain(apiKey);
    expect(readFileSync(stateFilePath, "utf8")).not.toContain(apiKey);
    const posted = uploads.filter((upload) => upload.action === "post");
    expect([...new Set(posted.map((upload) => upload.payload.session_name))]).toEqual([
      "the-turns-project",
    ]);
    expect(JSON.stringify(uploads)).toContain("stop-origin-marker");
  });
});

function recoveredBuffer(): TurnBuffer {
  const { swept } = replayHookLog(HEADLESS, FINAL_SWEEP);
  return { ...swept[0].buffer, tracingMode: "full" };
}

describe("run ids that survive a re-upload", () => {
  async function postedRunIds(buffer: TurnBuffer, turnNum: number): Promise<string[]> {
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, true, undefined, client);
    await buildTurnRuns({ buffer, conversationId: HEADLESS_CONV, turnNum, project: "cursor" });
    const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
    return Object.values(tree.data)
      .map((run) => run.id)
      .sort();
  }

  it("repeats a turn's ids on re-upload and never reuses them for another turn", async () => {
    const buffer = recoveredBuffer();
    const first = await postedRunIds(buffer, 1);

    expect(first.length).toBeGreaterThan(HEADLESS_TOOLS);
    expect(new Set(first).size).toBe(first.length);
    expect(await postedRunIds(buffer, 1)).toEqual(first);
    for (const id of first) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }

    const other = await postedRunIds({ ...buffer, generation_id: "another-generation" }, 2);
    expect(other.some((id) => first.includes(id))).toBe(false);
  });
});
