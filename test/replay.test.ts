import { describe, it, expect } from "vitest";
import { join } from "node:path";
import type { Run } from "langsmith";
import { replayHookLog } from "./utils/replay.js";
import { mockClient } from "./utils/mock_client.js";
import { getAssumedTreeFromCalls } from "./utils/tree.js";
import { initTracing, buildTurnRuns, flushPendingTraces } from "../src/langsmith.js";
import type { TurnBuffer } from "../src/types.js";
import type { Step } from "../src/conversation-steps.js";

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
    initTracing(undefined, undefined, undefined, true, undefined, client);

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
    initTracing(undefined, undefined, undefined, true, undefined, client);

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
    // The root turn is the parentless chain; the subagent is a nested chain.
    const root = Object.values(tree.data).find((r) => r.run_type === "chain" && !r.parent_run_id)!;
    const task = Object.values(tree.data).find((r) => r.name?.endsWith("Subagent"))!;

    expect(task).toBeDefined();
    // A subagent is a nested chain run (validator runType "subagent"), not a tool.
    expect(task.run_type).toBe("chain");
    expect(task.parent_run_id).toBe(root.id);
    // Run name surfaces the subagent kind; metadata carries model + parallel flag.
    expect(task.name).toBe("explore Subagent");
    expect(meta(task).subagent_model).toBe("composer-2.5-fast");
    expect(meta(task).subagent_provider).toBe("cursor");
    expect(meta(task).subagent_is_parallel_worker).toBe(false);
    expect(meta(task).subagent_description).toBe("Summarize repository architecture");
    // coding-agent-v1 subagent identity keys live on the subagent run.
    expect(meta(task).ls_subagent_id).toBeDefined();
    expect(meta(task).ls_subagent_type).toBe("explore");

    // The subagent's internal tool calls nest under the Subagent run...
    const nested = Object.values(tree.data).filter((r) => r.parent_run_id === task.id);
    const nestedTools = nested.filter((r) => r.run_type === "tool");
    expect(nestedTools.length).toBe(35);
    expect(nestedTools.some((r) => r.name === "Read")).toBe(true);
    // ...sandwiched between a decide llm and an answer llm, both carrying the model.
    const nestedLlm = nested.filter((r) => r.run_type === "llm");
    expect(nestedLlm.length).toBe(2);
    expect(nestedLlm.every((r) => meta(r).ls_model_name === "composer-2.5-fast")).toBe(true);
    expect(nestedLlm.every((r) => meta(r).ls_provider === "cursor")).toBe(true);
    // ...while staying part of the same trace (root), not a separate trace.
    expect(nested.every((r) => r.trace_id === root.id)).toBe(true);
    // Subagent-only keys must NOT leak onto the subagent's llm/tool children.
    expect(nested.every((r) => meta(r).ls_subagent_id === undefined)).toBe(true);
    expect(nested.every((r) => meta(r).ls_subagent_type === undefined)).toBe(true);
    // The subagent task is a system instruction, never a "user" turn.
    const subInputs = nestedLlm.flatMap(
      (r) => (r.inputs as { messages?: Array<{ role?: string }> }).messages ?? [],
    );
    expect(subInputs.some((m) => m.role === "system")).toBe(true);
    expect(subInputs.some((m) => m.role === "user")).toBe(false);
  });

  it("emits tool_call content blocks in the llm assistant message", async () => {
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, true, undefined, client);

    const { finalized } = replayHookLog(CAPTURE);
    // A turn whose assistant invoked at least one tool directly.
    const turn = finalized.find((f) => f.buffer.tools.length > 0)!;
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
    const content = (llm.outputs as { messages: { content: Array<Record<string, unknown>> }[] })
      .messages[0].content;

    const toolCalls = content.filter((b) => b.type === "tool_call");
    expect(toolCalls.length).toBe(turn.buffer.tools.length);
    // Each block carries the LangChain tool_call shape (name + args + id).
    const first = turn.buffer.tools[0];
    expect(toolCalls).toContainEqual({
      type: "tool_call",
      name: first.name,
      args: first.input,
      id: first.tool_use_id,
    });
  });

  it("orders the decide llm first, then tools, then the answer llm", async () => {
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, true, undefined, client);

    const { finalized } = replayHookLog(CAPTURE);
    const turn = finalized.find((f) => f.buffer.tools.length > 0)!;

    await buildTurnRuns({
      buffer: turn.buffer,
      conversationId: turn.conversationId,
      turnNum: turn.turnNum,
      project: "test",
    });
    await flushPendingTraces();

    const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
    const root = Object.values(tree.data).find((r) => r.run_type === "chain")!;
    const children = Object.values(tree.data)
      .filter((r) => r.parent_run_id === root.id)
      .sort((a, b) => (a.dotted_order! < b.dotted_order! ? -1 : 1));

    // First child is the "decide" llm, last is the "answer" llm, tools in between.
    expect(children[0].run_type).toBe("llm");
    expect(children[children.length - 1].run_type).toBe("llm");
    const middle = children.slice(1, -1);
    expect(middle.length).toBe(turn.buffer.tools.length);
    expect(middle.every((r) => r.run_type === "tool")).toBe(true);
  });

  it("renders a subagent invocation as a Task tool_call block in the llm message", async () => {
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, true, undefined, client);

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
    // The parent's "decide" llm (direct child of the root chain) emits the Subagent call.
    const root = Object.values(tree.data).find((r) => r.run_type === "chain" && !r.parent_run_id)!;
    const decide = Object.values(tree.data).find(
      (r) => r.run_type === "llm" && r.parent_run_id === root.id,
    )!;
    const content = (decide.outputs as { messages: { content: Array<Record<string, unknown>> }[] })
      .messages[0].content;

    const taskCall = content.find((b) => b.type === "tool_call" && b.name === "Subagent");
    expect(taskCall).toBeDefined();
    expect((taskCall!.args as { subagent_type?: string }).subagent_type).toBe("explore");
  });

  it("emits attachment content parts on the llm + root inputs (inline-render shape)", async () => {
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, true, undefined, client);

    const { finalized } = replayHookLog(CAPTURE);
    const turn = finalized[0];
    const imagePart = { type: "image" as const, mime_type: "image/png", base64: "iVBORw0KGgo=" };

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

  it("canonicalizes the model and emits tokens (cost left to LangSmith)", async () => {
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, true, undefined, client);

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
    // Usage sits on the answer llm run (agentic turns have two llm runs).
    const llm = Object.values(tree.data).find(
      (r) => r.run_type === "llm" && meta(r).usage_metadata != null,
    )!;
    const usage = meta(llm).usage_metadata as { total_cost?: number; total_tokens?: number };
    expect(meta(llm).ls_model_name).toBe("claude-sonnet-4-6"); // canonicalized
    expect(usage.total_tokens).toBeGreaterThan(0);
    expect(usage.total_cost).toBeUndefined(); // server-side pricing only
  });
});

describe("buildTurnRuns interleaved step fidelity", () => {
  const startMs = 1000;
  const buffer: TurnBuffer = {
    generation_id: "gen-1",
    prompt: "do stuff",
    model: "claude-4.6-sonnet",
    startMs,
    thoughts: [],
    subagents: [],
    finalText: "all done",
    usage: { input_tokens: 100, output_tokens: 50 },
    status: "completed",
    tools: [
      {
        tool_use_id: "tool_a",
        name: "Read",
        input: { path: "x" },
        output: "data",
        duration: 1,
        endMs: 3000,
      },
      {
        tool_use_id: "tool_b",
        name: "Grep",
        input: { q: "y" },
        output: "hits",
        duration: 1,
        endMs: 4000,
      },
      {
        tool_use_id: "tool_c",
        name: "Shell",
        input: { cmd: "ls" },
        output: "files",
        duration: 1,
        endMs: 6000,
      },
    ],
  };
  // thinking → assistant → [Read, Grep] | thinking → [Shell] | assistant(final)
  const steps: Step[] = [
    { kind: "thinking", text: "plan" },
    { kind: "assistant", text: "looking" },
    { kind: "tool", toolUseId: "tool_a", toolField: 8, toolName: "Read" },
    { kind: "tool", toolUseId: "tool_b", toolField: 5, toolName: "Grep" },
    { kind: "thinking", text: "next" },
    { kind: "tool", toolUseId: "tool_c", toolField: 1, toolName: "Shell" },
    { kind: "assistant", text: "all done" },
  ];

  it("renders one llm run per round plus a final answer, interleaved with tools", async () => {
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, true, undefined, client);

    await buildTurnRuns({ buffer, conversationId: "conv-x", turnNum: 1, project: "test", steps });
    await flushPendingTraces();

    const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
    const llms = Object.values(tree.data).filter((r) => r.run_type === "llm");
    const tools = Object.values(tree.data).filter((r) => r.run_type === "tool");

    // Two action rounds + one final answer round = three llm runs.
    expect(llms.length).toBe(3);
    // Tool run set stays the hook-captured set (joined by tool_use_id), in true order.
    expect(tools.map((t) => t.name).sort()).toEqual(["Grep", "Read", "Shell"]);

    // Usage sits on exactly one llm run — the final answer.
    const withUsage = llms.filter((r) => meta(r).usage_metadata != null);
    expect(withUsage.length).toBe(1);
    const answer = withUsage[0];
    const answerContent = (
      answer.outputs as { messages: { content: Array<Record<string, unknown>> }[] }
    ).messages[0].content;
    expect(answerContent).toContainEqual({ type: "text", text: "all done" });

    // The first round's llm carries intermediate assistant text + its tool_call blocks.
    const round0 = llms.find((r) => {
      const c = (r.outputs as { messages: { content: Array<Record<string, unknown>> }[] })
        .messages[0].content;
      return c.some((b) => b.type === "text" && b.text === "looking");
    })!;
    expect(round0).toBeDefined();
    const r0Content = (
      round0.outputs as { messages: { content: Array<Record<string, unknown>> }[] }
    ).messages[0].content;
    const r0ToolCalls = r0Content.filter((b) => b.type === "tool_call").map((b) => b.id);
    expect(r0ToolCalls).toEqual(["tool_a", "tool_b"]);
  });

  it("falls back to the decide/answer shape when steps don't match the buffered tools", async () => {
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, true, undefined, client);

    // Steps reference tool ids absent from the buffer → no anchor → fall back.
    const orphanSteps: Step[] = [
      { kind: "assistant", text: "looking" },
      { kind: "tool", toolUseId: "tool_zzz", toolField: 8, toolName: "Read" },
      { kind: "assistant", text: "all done" },
    ];
    await buildTurnRuns({
      buffer,
      conversationId: "conv-x",
      turnNum: 1,
      project: "test",
      steps: orphanSteps,
    });
    await flushPendingTraces();

    const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
    const llms = Object.values(tree.data).filter((r) => r.run_type === "llm");
    // Decide/answer shape: exactly two llm runs (not three rounds).
    expect(llms.length).toBe(2);
  });
});
