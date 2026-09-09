import { expect, it } from "vitest";
import { join } from "node:path";
import { replayHookLog } from "./utils/replay.js";
import { mockClient } from "./utils/mock_client.js";
import { getAssumedTreeFromCalls } from "./utils/tree.js";
import { buildTurnRuns, initTracing } from "../src/langsmith.js";
import {
  reduceStop,
  reduceBeforeSubmitPrompt,
  reducePostToolUse,
  reduceSubagentStart,
  reduceSubagentStop,
} from "../src/reducer.js";
import { MUTED_TRACE_CONTENT } from "../src/privacy.js";
import type { TurnMode } from "../src/types.js";

it("replays identical full/muted topology and nested ownership without content backfill", async () => {
  const { finalized } = replayHookLog(join(process.cwd(), "test/fixtures/cursor-hooks.jsonl"));
  const turn = finalized.find((t) => t.buffer.subagents.length)!;
  const shapes = [];
  for (const mode of ["full", "metadata"] as const) {
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, false, undefined, client);
    await buildTurnRuns({
      ...turn,
      buffer: { ...turn.buffer, tracingMode: mode },
      project: "test",
      customMetadata: {
        thread_id: "UNSAFE",
        usage_metadata: { total_tokens: 999999 },
        cwd: "UNSAFE",
        ls_tool_name: "UNSAFE",
      },
    });
    const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
    const runs = Object.values(tree.data);
    shapes.push(
      runs
        .map((r) => ({
          name: r.name,
          type: r.run_type,
          start: r.start_time,
          parent: runs.find((p) => p.id === r.parent_run_id)?.name,
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
    if (mode === "metadata") {
      for (const run of runs) {
        expect(run.inputs).toEqual({ messages: [{ role: "user", content: MUTED_TRACE_CONTENT }] });
        expect(run.outputs).toEqual({
          messages: [{ role: "assistant", content: MUTED_TRACE_CONTENT }],
        });
        expect(run.extra?.metadata).toMatchObject({
          ls_tracing_mode: "metadata",
          thread_id: turn.conversationId,
        });
        expect(JSON.stringify(run)).not.toContain("UNSAFE");
        expect(JSON.stringify(run)).not.toContain("999999");
        expect(run.error).toBeUndefined();
      }
      expect(runs.filter((r) => r.run_type === "tool")).toHaveLength(turn.buffer.tools.length + 35);
      expect(runs.filter((r) => r.extra?.metadata?.status === "error").length).toBeGreaterThan(0);
    }
  }
  expect(shapes[0]).toEqual(shapes[1]);
});

it.each(["off", undefined] as const)(
  "uses safe %s launch evidence even after unmute",
  async (mode) => {
    const { finalized } = replayHookLog(join(process.cwd(), "test/fixtures/cursor-hooks.jsonl"));
    const turn = finalized[0];
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, false, undefined, client);
    await buildTurnRuns({
      ...turn,
      buffer: { ...turn.buffer, tracingMode: mode as TurnMode },
      project: "test",
    });
    if (mode === "off") expect(callSpy).not.toHaveBeenCalled();
    else {
      const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
      for (const run of Object.values(tree.data))
        expect(run.extra?.metadata?.ls_tracing_mode).toBe("metadata");
    }
  },
);

it("Stop consumes only its generation; duplicate Stop cannot replay old muted history", () => {
  const { finalized } = replayHookLog(join(process.cwd(), "test/fixtures/cursor-hooks.jsonl"));
  const turn = finalized[0];
  const state = {
    [turn.conversationId]: {
      turn_count: 0,
      updated: new Date().toISOString(),
      turns: {
        [turn.buffer.generation_id]: { ...turn.buffer, tracingMode: "metadata" as const },
      },
    },
  };
  const first = reduceStop(state, turn.stopInput, Date.now());
  expect(first.buffer?.tracingMode).toBe("metadata");
  expect(reduceStop(first.state, turn.stopInput, Date.now()).buffer).toBeUndefined();
});

it("preserves interleaved DB round topology while dropping repeated private context", async () => {
  const buffer = {
    generation_id: "steps",
    startMs: 1000,
    prompt: "PRIVATE",
    thoughts: [],
    subagents: [],
    finalText: "PRIVATE",
    model: "default",
    tools: [
      {
        tool_use_id: "a",
        name: "Read",
        input: { path: "PRIVATE" },
        output: "PRIVATE",
        endMs: 2000,
      },
      {
        tool_use_id: "b",
        name: "Shell",
        input: { command: "PRIVATE" },
        output: "PRIVATE",
        endMs: 3000,
      },
    ],
  };
  const steps = [
    { kind: "thinking" as const, text: "PRIVATE" },
    { kind: "tool" as const, toolUseId: "a" },
    { kind: "assistant" as const, text: "PRIVATE" },
    { kind: "tool" as const, toolUseId: "b" },
    { kind: "assistant" as const, text: "PRIVATE" },
  ];
  const shapes = [];
  for (const mode of ["full", "metadata"] as const) {
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, false, undefined, client);
    await buildTurnRuns({
      buffer: { ...buffer, tracingMode: mode },
      steps,
      conversationId: "thread",
      turnNum: 1,
      project: "test",
    });
    const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
    const runs = Object.values(tree.data);
    shapes.push(
      runs.map((r) => [
        r.name,
        r.run_type,
        r.start_time,
        runs.find((p) => p.id === r.parent_run_id)?.name,
      ]),
    );
    if (mode === "metadata") expect(JSON.stringify(tree.data)).not.toContain("PRIVATE");
  }
  expect(shapes[0]).toEqual(shapes[1]);
});

it.each(["full", "metadata"] as const)(
  "a %s parent owns nested tools despite later preference changes",
  async (launch) => {
    const base = { conversation_id: "parent", generation_id: "active", model: "default" };
    let state = reduceBeforeSubmitPrompt(
      {},
      { ...base, prompt: "PRIVATE", hook_event_name: "beforeSubmitPrompt" },
      1000,
      launch,
    );
    state = reduceSubagentStart(
      state,
      {
        ...base,
        hook_event_name: "subagentStart",
        subagent_id: "sub",
        subagent_type: "explore",
        task: "PRIVATE",
      },
      1100,
    );
    // A queued/new generation has the opposite policy; active parent is unchanged.
    state = reduceBeforeSubmitPrompt(
      state,
      { ...base, generation_id: "next", prompt: "next", hook_event_name: "beforeSubmitPrompt" },
      1200,
      launch === "full" ? "metadata" : "full",
    );
    state = reducePostToolUse(
      state,
      {
        ...base,
        conversation_id: "child",
        generation_id: "childgen",
        hook_event_name: "postToolUse",
        tool_name: "Read",
        tool_use_id: "tool",
        tool_input: { path: "PRIVATE" },
        tool_output: "PRIVATE",
      },
      1300,
    );
    state = reduceSubagentStop(
      state,
      {
        ...base,
        hook_event_name: "subagentStop",
        subagent_id: "sub",
        subagent_type: "explore",
        status: "completed",
      },
      1400,
      { childConversationId: "child", resultText: "PRIVATE" },
    );
    const stopped = reduceStop(
      state,
      { ...base, hook_event_name: "stop", status: "completed" },
      1500,
    );
    expect(stopped.buffer?.tracingMode).toBe(launch);
    expect(stopped.buffer?.subagents[0].tools).toHaveLength(1);
    expect(stopped.state.parent.turns.next.tracingMode).not.toBe(launch);
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, false, undefined, client);
    await buildTurnRuns({
      buffer: stopped.buffer!,
      conversationId: "parent",
      turnNum: 1,
      project: "test",
    });
    const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
    const raw = JSON.stringify(tree.data);
    if (launch === "metadata") expect(raw).not.toContain("PRIVATE");
    else expect(raw).toContain("PRIVATE");
  },
);

it("does not treat a conversation-valued generation_id as proof even if that buffer exists", () => {
  const base = { conversation_id: "parent", generation_id: "muted", model: "default" };
  let state = reduceBeforeSubmitPrompt(
    {},
    {
      ...base,
      hook_event_name: "beforeSubmitPrompt",
      prompt: "private",
    },
    1000,
    "metadata",
  );
  state = reduceBeforeSubmitPrompt(
    state,
    {
      ...base,
      generation_id: "parent",
      hook_event_name: "beforeSubmitPrompt",
      prompt: "public",
    },
    2000,
    "full",
  );
  state = reduceSubagentStart(
    state,
    {
      ...base,
      generation_id: "parent",
      parent_conversation_id: "parent",
      session_id: "parent",
      hook_event_name: "subagentStart",
      subagent_id: "sub",
      subagent_type: "explore",
      task: "private",
    },
    2100,
  );
  expect(state.parent.turns.parent.subagents[0].tracingMode).toBe("metadata");
  expect(state.parent.turns.muted.subagents).toEqual([]);
});
