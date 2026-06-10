import { describe, it, expect } from "vitest";
import { join } from "node:path";
import type { Run } from "langsmith";
import { replayHookLog } from "./utils/replay.js";
import { mockClient } from "./utils/mock_client.js";
import { getAssumedTreeFromCalls } from "./utils/tree.js";
import { initTracing, buildTurnRuns, flushPendingTraces } from "../src/langsmith.js";

const CAPTURE = join(process.cwd(), "test/fixtures/cursor-hooks.jsonl");
const PARENT_CONV = "6bd3db3e-e838-485e-befc-b5f0d05b18cd";
const CHILD_CONV = "3e6a5f09-8e10-4614-8714-152f3cc1b719";

function meta(run: Run): Record<string, unknown> {
  return (run.extra as { metadata?: Record<string, unknown> })?.metadata ?? {};
}

describe("replay run2 hooks.jsonl through the event-buffer reducers", () => {
  const { finalized, finalState } = replayHookLog(CAPTURE);

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

  it("nests the subagent's internal tool calls (temporal linking, no disk)", () => {
    const sub = finalized.find((f) => f.buffer.subagents.length > 0)!.buffer.subagents[0];
    // The child conversation's 35 buffered tool events (34 postToolUse +
    // 1 postToolUseFailure) are spliced onto the subagent via temporal linking.
    expect(sub.tools?.length).toBe(35);
    expect(sub.childConversationId).toBe(CHILD_CONV);
    const names = new Set(sub.tools!.map((t) => t.name));
    expect(names).toContain("Read");
    expect(names).toContain("Grep");
    // Rich tool I/O: outputs and durations carried from postToolUse hooks.
    expect(sub.tools!.some((t) => t.output != null)).toBe(true);
    // A failed tool is captured too (a Read of a missing file).
    expect(sub.tools!.some((t) => t.error != null)).toBe(true);
  });

  it("captures per-turn usage and a concrete model where available", () => {
    const first = finalized[0];
    expect(first.buffer.usage?.input_tokens).toBeGreaterThan(0);
    // a later turn used a concrete (non-default) model
    expect(finalized.some((f) => f.buffer.model && f.buffer.model !== "default")).toBe(true);
  });

  it("consumes the subagent's child conversation (no orphan left behind)", () => {
    // The child conversation holding the subagent's tools is spliced into the
    // parent's Task run at subagentStop and removed from state.
    expect(Object.keys(finalState)).not.toContain(CHILD_CONV);
    const orphanConvs = Object.keys(finalState).filter((c) => c !== PARENT_CONV);
    expect(orphanConvs.length).toBe(0);
  });
});

describe("buildTurnRuns produces the expected LangSmith run tree", () => {
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

    // The subagent's internal tool calls nest under the Task run...
    const nested = Object.values(tree.data).filter((r) => r.parent_run_id === task.id);
    expect(nested.length).toBe(35);
    expect(nested.every((r) => r.run_type === "tool")).toBe(true);
    // ...while staying part of the same trace (root), not a separate trace.
    expect(nested.every((r) => r.trace_id === root.id)).toBe(true);
    expect(nested.some((r) => r.name === "Read")).toBe(true);
  });

  it("emits attachment content parts on the llm + root inputs (inline-render shape)", async () => {
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, client);

    const { finalized } = replayHookLog(CAPTURE);
    const turn = finalized[0];
    const imagePart = { type: "image", mime_type: "image/png", base64: "iVBORw0KGgo=" };

    await buildTurnRuns({
      buffer: turn.buffer,
      conversationId: turn.conversationId,
      turnNum: turn.turnNum,
      project: "test",
      attachments: [imagePart],
    });
    await flushPendingTraces();

    const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
    const llm = Object.values(tree.data).find((r) => r.run_type === "llm")!;
    const root = Object.values(tree.data).find((r) => r.run_type === "chain")!;

    // The user message is a content-part array (text + image); the image part
    // matches the LangChain v1 inline-render shape.
    const llmContent = (llm.inputs as { messages: { content: unknown[] }[] }).messages[0].content;
    expect(Array.isArray(llmContent)).toBe(true);
    expect(llmContent).toContainEqual(imagePart);
    expect(llmContent).toContainEqual({ type: "text", text: turn.buffer.prompt });

    const rootContent = (root.inputs as { messages?: { content: unknown[] }[] }).messages?.[0]
      .content;
    expect(rootContent).toContainEqual(imagePart);
  });

  it("attaches cost for a priced model (the claude turn)", async () => {
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, client);

    const { finalized } = replayHookLog(CAPTURE);
    const turn = finalized.find((f) => (f.buffer.model ?? "").includes("claude"))!;
    expect(turn).toBeDefined();

    await buildTurnRuns({
      buffer: turn.buffer,
      conversationId: turn.conversationId,
      turnNum: turn.turnNum,
      project: "test",
    });
    await flushPendingTraces();

    const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
    const llm = Object.values(tree.data).find((r) => r.run_type === "llm")!;
    const usage = meta(llm).usage_metadata as { total_cost?: number; total_tokens?: number };
    expect(meta(llm).ls_model_name).toBe("claude-sonnet-4-6"); // canonicalized
    expect(usage.total_tokens).toBeGreaterThan(0);
    expect(usage.total_cost).toBeGreaterThan(0);
  });
});
