import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Run } from "langsmith";
import { replayHookLog } from "./utils/replay.js";
import { mockClient } from "./utils/mock_client.js";
import { getAssumedTreeFromCalls } from "./utils/tree.js";
import { initTracing, buildTurnRuns, flushPendingTraces } from "../src/langsmith.js";

const CAPTURE = join(process.cwd(), "diagnostics/captures/run2/cursor-diag/hooks.jsonl");
const PARENT_CONV = "6bd3db3e-e838-485e-befc-b5f0d05b18cd";

function meta(run: Run): Record<string, unknown> {
  return (run.extra as { metadata?: Record<string, unknown> })?.metadata ?? {};
}

describe("replay run2 hooks.jsonl through the event-buffer reducers", () => {
  const { finalized, finalState } = replayHookLog(CAPTURE);

  it("the capture exists", () => {
    expect(existsSync(CAPTURE)).toBe(true);
  });

  it("finalizes one turn per stop, all in the same conversation/thread", () => {
    expect(finalized.length).toBe(6);
    expect(new Set(finalized.map((f) => f.conversationId))).toEqual(new Set([PARENT_CONV]));
    // turn numbers are sequential within the conversation
    expect(finalized.map((f) => f.turnNum)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("captures tool turns and exactly one subagent turn", () => {
    const withTools = finalized.filter((f) => f.buffer.tools.length > 0);
    expect(withTools.length).toBeGreaterThanOrEqual(1);

    const withSubagents = finalized.filter((f) => f.buffer.subagents.length > 0);
    expect(withSubagents.length).toBe(1);
    expect(withSubagents[0].buffer.subagents[0].subagent_type).toBe("explore");
  });

  it("captures per-turn usage and a concrete model where available", () => {
    const first = finalized[0];
    expect(first.buffer.usage?.input_tokens).toBeGreaterThan(0);
    // a later turn used a concrete (non-default) model
    expect(finalized.some((f) => f.buffer.model && f.buffer.model !== "default")).toBe(true);
  });

  it("leaves the subagent's child conversation as an un-traced orphan", () => {
    // The subagent's internal tool calls fire under a separate conversation_id
    // that never stops — it should remain buffered, never finalized.
    const orphanConvs = Object.keys(finalState).filter((c) => c !== PARENT_CONV);
    expect(orphanConvs.length).toBeGreaterThanOrEqual(1);
  });
});

describe("buildTurnRuns produces the expected LangSmith run tree", () => {
  beforeEach(() => {
    const { client } = mockClient();
    initTracing(undefined, undefined, undefined, client);
  });

  it("builds Turn(chain) → llm with thread_id + usage_metadata", async () => {
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, client);

    const { finalized } = replayHookLog(CAPTURE);
    const turn = finalized[0]; // "hi" turn, has usage

    await buildTurnRuns({
      buffer: turn.buffer,
      conversationId: turn.conversationId,
      turnNum: turn.turnNum,
      project: "test",
    });
    await flushPendingTraces();

    const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);

    const root = Object.values(tree.data).find((r) => r.run_type === "chain")!;
    const llm = Object.values(tree.data).find((r) => r.run_type === "llm")!;

    expect(root.name).toBe("Cursor Turn 1");
    expect(meta(root).thread_id).toBe(PARENT_CONV);
    expect(llm.parent_run_id).toBe(root.id);
    expect(meta(llm).ls_provider).toBeDefined();
    expect(meta(llm).ls_model_name).toBeDefined();
    expect((meta(llm).usage_metadata as { total_tokens?: number })?.total_tokens).toBeGreaterThan(
      0,
    );
  });

  it("renders a subagent as a Task tool child of the turn", async () => {
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, client);

    const { finalized } = replayHookLog(CAPTURE);
    const turn = finalized.find((f) => f.buffer.subagents.length > 0)!;

    await buildTurnRuns({
      buffer: turn.buffer,
      conversationId: turn.conversationId,
      turnNum: turn.turnNum,
      project: "test",
    });
    await flushPendingTraces();

    const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
    const root = Object.values(tree.data).find((r) => r.run_type === "chain")!;
    const task = Object.values(tree.data).find((r) => r.name === "Task")!;

    expect(task).toBeDefined();
    expect(task.run_type).toBe("tool");
    expect(task.parent_run_id).toBe(root.id);
    expect(meta(task).subagent_type).toBe("explore");
  });
});
