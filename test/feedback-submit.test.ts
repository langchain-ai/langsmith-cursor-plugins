import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mockClient } from "./utils/mock_client.js";
import { replayHookLog } from "./utils/replay.js";
import { initTracing, buildTurnRuns, submitFeedback, flushPendingTraces } from "../src/langsmith.js";
import { reduceRecordLastTrace } from "../src/reducer.js";
import { parseFeedbackCommand } from "../src/feedback.js";
import { getAssumedTreeFromCalls } from "./utils/tree.js";
import type { TracingState } from "../src/types.js";

const CAPTURE = join(process.cwd(), "test/fixtures/cursor-hooks.jsonl");

/** Pull the POSTed feedback bodies out of the mock fetch calls. */
function feedbackPosts(calls: unknown[][]): Array<Record<string, unknown>> {
  return calls
    .filter(([url]) => String(url).includes("/feedback"))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

describe("buildTurnRuns → record last_trace → submitFeedback", () => {
  it("buildTurnRuns returns the root run id, which becomes the feedback target", async () => {
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, client);

    const { finalized } = replayHookLog(CAPTURE);
    const turn = finalized[0];
    const built = await buildTurnRuns({
      buffer: turn.buffer,
      conversationId: turn.conversationId,
      turnNum: turn.turnNum,
      project: "test",
    });
    await flushPendingTraces();

    // The returned id matches the chain (root) run actually posted.
    const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
    const root = Object.values(tree.data).find((r) => r.run_type === "chain")!;
    expect(built.runId).toBeTruthy();
    expect(built.traceId).toBe(built.runId);
    expect(root.id).toBe(built.runId);
  });

  it("posts good/bad/flag/note feedback to the run with the expected fields", async () => {
    const target = { runId: "11111111-1111-1111-1111-111111111111" };

    const cases = [
      { input: "/langsmith good", expect: { score: 1 } },
      { input: "/langsmith bad too many tokens", expect: { score: 0, comment: "too many tokens" } },
      { input: "/langsmith flag revisit", expect: { value: "flagged", comment: "revisit" } },
      { input: "/langsmith this was great", expect: { comment: "this was great" } },
    ];

    for (const c of cases) {
      const { client, callSpy } = mockClient();
      initTracing(undefined, undefined, undefined, client);
      const parsed = parseFeedbackCommand(c.input);
      if (parsed?.kind !== "feedback") throw new Error(`not feedback: ${c.input}`);

      const posted = await submitFeedback(target, {
        key: parsed.key,
        score: parsed.score,
        value: parsed.value,
        comment: parsed.comment,
      });
      expect(posted).toBe(1);

      const [body] = feedbackPosts(callSpy.mock.calls);
      expect(body.run_id).toBe(target.runId);
      expect(body.key).toBe("user_feedback");
      for (const [k, v] of Object.entries(c.expect)) {
        expect(body[k]).toBe(v);
      }
    }
  });

  it("reduceRecordLastTrace stores the run on the conversation for later feedback", () => {
    const state: TracingState = {};
    const next = reduceRecordLastTrace(state, "conv-1", {
      runId: "run-abc",
      traceId: "run-abc",
      turnNum: 3,
      finalizedAt: "2026-06-16T00:00:00.000Z",
    });
    expect(next["conv-1"].last_trace).toMatchObject({ runId: "run-abc", turnNum: 3 });
    expect(next["conv-1"].updated).not.toBe("");
  });
});
