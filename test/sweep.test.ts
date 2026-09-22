import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Run } from "langsmith";
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
import { runSweep, sweepTracingMode } from "../src/sweep.js";
import { loadState, saveState } from "../src/state.js";
import type { Config } from "../src/config.js";
import { MUTED_TRACE_CONTENT } from "../src/privacy.js";
import { initTracing, buildTurnRuns } from "../src/langsmith.js";
import { replayHookLog } from "./utils/replay.js";
import { mockClient } from "./utils/mock_client.js";
import { getAssumedTreeFromCalls } from "./utils/tree.js";
import { HOUR, MINUTE, T0, conversation, testConfig, tool, turn } from "./utils/state.js";
import type { ConversationState, HookInputBase, TracingState, TurnBuffer } from "../src/types.js";

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

function stranded(): TracingState {
  return { c1: conversation([turn("g1", T0)]) };
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

function stopSubagent(state: TracingState): TracingState {
  return reduceSubagentStop(
    state,
    {
      hook_event_name: "subagentStop",
      conversation_id: "parent",
      generation_id: "gp",
      model: "default",
      subagent_id: "s1",
      subagent_type: "explore",
    },
    T0 + MINUTE,
    { childConversationId: "child" },
  );
}

function stopInput(conversationId: string, generationId: string) {
  return {
    hook_event_name: "stop",
    conversation_id: conversationId,
    generation_id: generationId,
    model: "default",
  } as const;
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
    const state = reduceAfterAgentResponse(
      stranded(),
      {
        hook_event_name: "afterAgentResponse",
        conversation_id: "c1",
        generation_id: "g1",
        model: "default",
        text: "streamed after 70 minutes of thinking",
      },
      T0 + 70 * MINUTE,
    );
    expect(state.c1.turns.g1.finalTextArrivedMs).toBe(T0 + 70 * MINUTE);
    expect(reduceSweep(state, CALLER, T0 + 2 * HOUR, THRESHOLD).claims).toEqual([]);
    expect(reduceSweep(state, CALLER, T0 + 3 * HOUR, THRESHOLD).claims.length).toBe(1);
  });

  it("marks a recovered turn incomplete and keeps its tools", () => {
    const state: TracingState = {
      c1: conversation([turn("g1", T0, { tools: [tool("t1", "Read", T0, { path: "a.ts" })] })]),
    };
    const claim = reduceSweep(state, CALLER, T0 + 2 * HOUR, THRESHOLD).claims[0];
    expect(claim.buffer.status).toBe("incomplete");
    expect(claim.buffer.finalText).toBeUndefined();
    expect(claim.buffer.tools.length).toBe(1);
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
    const state: TracingState = {
      parent: subagentParent(),
      child: conversation([], {
        turn_count: 1,
        pending: { gc: { buffer: turn("gc", T0), turnNum: 1, claimedAt: T0, attempts: 1 } },
      }),
    };
    const next = stopSubagent(state);
    expect(next.parent.turns.gp.subagents[0].childConversationId).toBe("child");
    expect(next.child.pending!.gc.turnNum).toBe(1);
    expect(next.child.turns).toEqual({});
  });

  it("consumes a child that has nothing pending", () => {
    const next = stopSubagent(parentAndChild());
    expect(next.child).toBeUndefined();
    expect(next.parent.turns.gp.subagents[0].tools!.map((t) => t.name)).toEqual(["Grep"]);
  });

  it("never consumes the parent's own thread when the child id points back at it", () => {
    const state: TracingState = { parent: subagentParent() };
    const next = reduceSubagentStop(
      state,
      {
        hook_event_name: "subagentStop",
        conversation_id: "parent",
        generation_id: "gp",
        model: "default",
        subagent_id: "s1",
        subagent_type: "explore",
      } as never,
      T0 + MINUTE,
      { childConversationId: "parent" },
    );

    expect(Object.keys(next.parent.turns)).toEqual(["gp"]);
    expect(next.parent.turns.gp.subagents[0].childConversationId).toBeUndefined();
  });
});

describe("reduceSweep claims are exactly once", () => {
  it("does not re-claim a turn on the next sweep", () => {
    const first = reduceSweep(stranded(), CALLER, T0 + 2 * HOUR, THRESHOLD);
    expect(first.claims.length).toBe(1);

    const second = reduceSweep(first.state, CALLER, T0 + 2 * HOUR + MINUTE, THRESHOLD);
    expect(second.claims).toEqual([]);
    expect(second.state.c1.turn_count).toBe(1);
    expect(second.state.c1.pending!.g1.attempts).toBe(1);
  });

  it("clears the pending entry once the upload resolves", () => {
    const first = reduceSweep(stranded(), CALLER, T0 + 2 * HOUR, THRESHOLD);
    const settled = reduceUploadSettled(first.state, "c1", "g1", T0 + 2 * HOUR);
    expect(settled.c1.pending).toBeUndefined();
    expect(reduceSweep(settled, CALLER, T0 + 10 * HOUR, THRESHOLD).claims).toEqual([]);
  });

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

  it("holds a stop-finalized turn as pending until it is settled", () => {
    const state: TracingState = { c1: conversation([turn("g1", T0, { tracingMode: "full" })]) };
    const result = reduceStop(state, stopInput("c1", "g1"), T0 + MINUTE);
    expect(result.buffer).toBeDefined();
    expect(result.state.c1.pending!.g1.attempts).toBe(1);
    expect(reduceUploadSettled(result.state, "c1", "g1", T0 + MINUTE).c1.pending).toBeUndefined();
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

  it("reopens the turn and warns that the sweep fired too early", () => {
    const swept = reduceSweep(stranded(), CALLER, T0 + 2 * HOUR, THRESHOLD).state;
    expect(swept.c1.sweepFinalizedGenerations).toEqual(["g1"]);

    const late = reduceAfterAgentResponse(
      swept,
      {
        hook_event_name: "afterAgentResponse",
        conversation_id: "c1",
        generation_id: "g1",
        model: "default",
        text: "arrived too late",
      },
      T0 + 3 * HOUR,
    );
    expect(late.c1.turns.g1.finalText).toBe("arrived too late");
    expect(late.c1.turns.g1.turnNum).toBe(1);
    expect(late.c1.pending).toBeUndefined();
    expect(late.c1.sweepFinalizedGenerations).toEqual(["g1"]);
    expect(spy).toHaveBeenCalledWith(
      "Sweep recovered conversation c1 generation g1 too early; reopening it for a late afterAgentResponse",
    );
  });

  it("lets a real stop supersede a turn the sweep recorded as incomplete", () => {
    const swept = reduceSweep(stranded(), CALLER, T0 + 2 * HOUR, THRESHOLD);
    expect(swept.claims[0]).toMatchObject({ turnNum: 1 });
    expect(swept.claims[0].buffer.status).toBe("incomplete");

    const answered = reduceAfterAgentResponse(
      swept.state,
      {
        hook_event_name: "afterAgentResponse",
        conversation_id: "c1",
        generation_id: "g1",
        model: "default",
        text: "the real answer",
      },
      T0 + 3 * HOUR,
    );
    const stopped = reduceStop(
      answered,
      { ...stopInput("c1", "g1"), status: "completed" },
      T0 + 3 * HOUR + MINUTE,
    );

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

    const late = reducePostToolUse(
      stopped,
      {
        hook_event_name: "postToolUse",
        conversation_id: "c1",
        generation_id: "g1",
        model: "default",
        tool_name: "Read",
        tool_use_id: "late",
      } as never,
      T0 + 2 * MINUTE,
    );
    expect(late).toBe(stopped);
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

    const late = reducePostToolUse(
      settled,
      {
        hook_event_name: "postToolUse",
        conversation_id: "c1",
        generation_id: "g1",
        model: "default",
        tool_name: "Read",
        tool_use_id: "late",
      } as never,
      T0 + 3 * HOUR,
    );
    const reswept = reduceSweep(late, CALLER, T0 + 5 * HOUR, THRESHOLD);

    expect(reswept.claims.map((c) => c.generationId)).toEqual(["g1"]);
    expect(reswept.state.c1.turn_count).toBe(1);
    expect(whereIsIt(reswept.state, "g1")).toEqual(["pending"]);
  });
});

describe("tracing mode resolved from the privacy policy", () => {
  it("takes the thread's policy mode but never upgrades a muted buffer", () => {
    expect(sweepTracingMode(undefined, "full")).toBe("full");
    expect(sweepTracingMode(undefined, "metadata")).toBe("metadata");
    expect(sweepTracingMode("metadata", "full")).toBe("metadata");
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
    const { swept } = replayHookLog(HEADLESS, FINAL_SWEEP);
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, true, undefined, client);

    await buildTurnRuns({
      buffer: {
        ...swept[0].buffer,
        tracingMode: sweepTracingMode(swept[0].buffer.tracingMode, "full"),
      },
      conversationId: swept[0].conversationId,
      turnNum: swept[0].turnNum,
      project: "cursor",
    });

    const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
    const names = tree.nodes.map((n) => n.split(":")[0]);
    expect(names).toEqual(expect.arrayContaining(["Cursor Turn 1", "Read", "Grep", "Bash"]));

    const root = Object.entries(tree.data).find(([id]) => id.startsWith("Cursor Turn 1:"))![1];
    expect(root.error).toBe("incomplete");
    const meta = (root.extra as { metadata?: Record<string, unknown> }).metadata ?? {};
    expect(meta).toMatchObject({ thread_id: HEADLESS_CONV, turn_number: 1 });

    const readRun = Object.entries(tree.data).find(([id]) => id.startsWith("Read:"))![1] as Run;
    expect(JSON.stringify(readRun.inputs)).toContain("src/reducer.ts");
  });
});

describe("runSweep against the on-disk state file", () => {
  let dir: string;
  let stateFilePath: string;
  let config: Config;
  const savedPolicy = process.env.LANGSMITH_CURSOR_PRIVACY_FILE;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sweep-state-"));
    stateFilePath = join(dir, "langsmith-state.json");
    process.env.LANGSMITH_CURSOR_PRIVACY_FILE = join(dir, "absent-privacy.json");
    config = testConfig(stateFilePath);
    saveState(stateFilePath, {
      c1: conversation([
        turn("g1", T0, {
          prompt: "recover me",
          tools: [tool("t1", "Read", T0, { path: "a.ts" })],
        }),
      ]),
    });
  });

  afterEach(() => {
    if (savedPolicy === undefined) delete process.env.LANGSMITH_CURSOR_PRIVACY_FILE;
    else process.env.LANGSMITH_CURSOR_PRIVACY_FILE = savedPolicy;
    rmSync(dir, { recursive: true, force: true });
  });

  it("uploads a claimed turn once, under the same lock as the calling hook", async () => {
    const { client, callSpy } = mockClient();
    const uploaded = await runSweep({
      config,
      input: CALLER_INPUT,
      nowMs: T0 + 2 * HOUR,
      client,
      apply: (state) => ({ ...state, c2: conversation([turn("g2", T0 + 2 * HOUR)]) }),
    });

    expect(uploaded.map((c) => c.generationId)).toEqual(["g1"]);
    const after = loadState(stateFilePath);
    expect(after.c1).toMatchObject({ turns: {}, turn_count: 1 });
    expect(after.c1.pending).toBeUndefined();
    expect(Object.keys(after.c2.turns)).toEqual(["g2"]);

    const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
    const root = Object.entries(tree.data).find(([id]) => id.startsWith("Cursor Turn 1:"))![1];
    expect(JSON.stringify(root.inputs)).toContain("recover me");
    expect(JSON.stringify(root.inputs)).not.toContain(MUTED_TRACE_CONTENT);

    const second = await runSweep({
      config,
      input: CALLER_INPUT,
      nowMs: T0 + 2 * HOUR + MINUTE,
      client,
    });
    expect(second).toEqual([]);
  });

  it("uploads a recovered turn to the project its own window was configured for", async () => {
    saveState(stateFilePath, {
      c1: conversation([
        turn("g1", T0, {
          tracingMode: "full",
          origin: { project: "the-turns-project", customMetadata: { cwd: "/repo/the-turn" } },
        }),
      ]),
    });
    const { client, callSpy } = mockClient();

    await runSweep({
      config: { ...config, project: "the-sweepers-project", customMetadata: { cwd: "/repo/sweep" } },
      input: CALLER_INPUT,
      nowMs: T0 + 2 * HOUR,
      client,
    });

    const posted = callSpy.mock.calls
      .map(([, init]) => new TextDecoder().decode((init as RequestInit).body as Uint8Array))
      .map((body) => JSON.parse(body))
      .filter((run) => run.session_name);
    expect(posted.length).toBeGreaterThan(0);
    expect([...new Set(posted.map((run) => run.session_name))]).toEqual(["the-turns-project"]);
    expect([...new Set(posted.map((run) => run.extra.metadata.cwd))]).toEqual(["/repo/the-turn"]);
  });

  async function sweptTurnInputs(): Promise<string> {
    const { client, callSpy } = mockClient();
    await runSweep({ config, input: CALLER_INPUT, nowMs: T0 + 2 * HOUR, client });
    const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
    const root = Object.entries(tree.data).find(([id]) => id.startsWith("Cursor Turn 1:"))![1];
    return JSON.stringify(root.inputs);
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

  it("still applies the calling hook's reducer when the sweep is switched off", async () => {
    const uploaded = await runSweep({
      config: { ...config, sweepEnabled: false },
      input: CALLER_INPUT,
      nowMs: T0 + 5 * HOUR,
      apply: (state) => ({ ...state, c2: conversation([turn("g2", T0)]) }),
    });

    expect(uploaded).toEqual([]);
    const after = loadState(stateFilePath);
    expect(Object.keys(after).sort()).toEqual(["c1", "c2"]);
    expect(Object.keys(after.c1.turns)).toEqual(["g1"]);
  });
});

describe("run ids that survive a re-upload", () => {
  async function postedRunIds(
    buffer: TurnBuffer,
    conversationId: string,
    turnNum: number,
  ): Promise<string[]> {
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, true, undefined, client);
    await buildTurnRuns({ buffer, conversationId, turnNum, project: "cursor" });
    const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
    return Object.values(tree.data)
      .map((run) => run.id)
      .sort();
  }

  function recoveredBuffer(): TurnBuffer {
    const { swept } = replayHookLog(HEADLESS, FINAL_SWEEP);
    return { ...swept[0].buffer, tracingMode: "full" };
  }

  it("posts the same run ids when the same turn is uploaded twice", async () => {
    const buffer = recoveredBuffer();
    const first = await postedRunIds(buffer, HEADLESS_CONV, 1);
    const second = await postedRunIds(buffer, HEADLESS_CONV, 1);

    expect(first.length).toBeGreaterThan(HEADLESS_TOOLS);
    expect(new Set(first).size).toBe(first.length);
    expect(second).toEqual(first);
    for (const id of first) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it("gives another turn in the same thread run ids of its own", async () => {
    const buffer = recoveredBuffer();
    const mine = await postedRunIds(buffer, HEADLESS_CONV, 1);
    const other = await postedRunIds(
      { ...buffer, generation_id: "another-generation" },
      HEADLESS_CONV,
      2,
    );
    expect(other.some((id) => mine.includes(id))).toBe(false);
  });

  it("keeps the ids of a muted turn stable too", async () => {
    const buffer: TurnBuffer = { ...recoveredBuffer(), tracingMode: "metadata" };
    const first = await postedRunIds(buffer, HEADLESS_CONV, 1);
    const second = await postedRunIds(buffer, HEADLESS_CONV, 1);
    expect(first.length).toBeGreaterThan(1);
    expect(second).toEqual(first);
  });
});
