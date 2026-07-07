import { describe, it, expect } from "vitest";
import { join } from "node:path";
import type { Run } from "langsmith";
import { codingAgentMetadata } from "../src/metadata.js";
import { replayHookLog } from "./utils/replay.js";
import { mockClient } from "./utils/mock_client.js";
import { getAssumedTreeFromCalls } from "./utils/tree.js";
import { initTracing, buildTurnRuns, flushPendingTraces } from "../src/langsmith.js";

const CAPTURE = join(process.cwd(), "test/fixtures/cursor-hooks.jsonl");

function meta(run: Run): Record<string, unknown> {
  return (run.extra as { metadata?: Record<string, unknown> })?.metadata ?? {};
}

// ─── Helper unit tests ────────────────────────────────────────────────────────

describe("codingAgentMetadata helper", () => {
  it("always emits the identity block with the frozen cursor literals", () => {
    const m = codingAgentMetadata({ threadId: "conv-1" });
    expect(m.ls_agent_kind).toBe("coding_agent");
    expect(m.ls_integration).toBe("cursor");
    expect(m.ls_agent_runtime).toBe("Cursor");
    expect(m.ls_trace_schema_version).toBe("coding-agent-v1");
    expect(m.thread_id).toBe("conv-1");
  });

  it("emits turn + runtime version keys when known, omits when not", () => {
    const m = codingAgentMetadata({
      threadId: "c",
      turnId: "gen-9",
      turnNumber: 3,
      runtimeVersion: "3.7.19",
    });
    expect(m.turn_id).toBe("gen-9");
    expect(m.turn_number).toBe(3);
    expect(m.ls_agent_runtime_version).toBe("3.7.19");

    const bare = codingAgentMetadata({ threadId: "c" });
    expect("turn_id" in bare).toBe(false);
    expect("turn_number" in bare).toBe(false);
    expect("ls_agent_runtime_version" in bare).toBe(false);
  });

  it("emits subagent identity keys, and clearSubagent nulls them out (undefined)", () => {
    const sub = codingAgentMetadata({ threadId: "c", subagentId: "s1", subagentType: "explore" });
    expect(sub.ls_subagent_id).toBe("s1");
    expect(sub.ls_subagent_type).toBe("explore");

    const child = codingAgentMetadata({ threadId: "c", clearSubagent: true });
    // Present-but-undefined → dropped on JSON serialization, never reaches the server.
    expect(child.ls_subagent_id).toBeUndefined();
    expect(child.ls_subagent_type).toBeUndefined();
    expect(JSON.parse(JSON.stringify(child))).not.toHaveProperty("ls_subagent_id");
  });

  it("emits ls_tool_name only when the native tool name differs from the run name", () => {
    expect(
      codingAgentMetadata({ threadId: "c", toolName: "Bash", runName: "Bash" }).ls_tool_name,
    ).toBeUndefined();
    expect(
      codingAgentMetadata({ threadId: "c", toolName: "Task", runName: "Agent" }).ls_tool_name,
    ).toBe("Task");
  });

  it("lets base (user config) win on key collision", () => {
    const m = codingAgentMetadata({ threadId: "c", base: { thread_id: "override", extra: 1 } });
    expect(m.thread_id).toBe("override");
    expect(m.extra).toBe(1);
  });
});

// ─── Contract gate against a real fixture replay ──────────────────────────────
// Mirrors validate-thread.mjs's classify + required-key/leak rules in-process.

const ALWAYS = [
  ["ls_agent_kind", "coding_agent"],
  ["ls_integration", "cursor"],
  ["ls_agent_runtime", "Cursor"],
  ["ls_trace_schema_version", "coding-agent-v1"],
] as const;

/** Structural run classification (validator's cursor profile). */
function classify(run: Run): "root" | "interrupted" | "subagent" | "llm" | "tool" {
  if (run.run_type === "llm") return "llm";
  if (run.run_type === "tool") return "tool";
  if (run.parent_run_id) return "subagent";
  return run.error ? "interrupted" : "root";
}

describe("coding-agent-v1 contract on the produced run tree", () => {
  it("stamps required keys on every run type and never leaks scope-restricted keys", async () => {
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, true, undefined, client);

    const { finalized } = replayHookLog(CAPTURE);
    const turn = finalized.find((f) => f.buffer.subagents.length > 0)!; // exercises every run type

    await buildTurnRuns({
      buffer: turn.buffer,
      conversationId: turn.conversationId,
      turnNum: turn.turnNum,
      project: "test",
      runtimeVersion: "3.7.19",
      userEmail: "dev@example.com",
      customMetadata: {
        ls_integration_version: "0.3.0",
        repository_url: "https://github.com/langchain-ai/langsmith-cursor-plugins",
        repository_provider: "github",
        repository_name: "langchain-ai/langsmith-cursor-plugins",
        git_branch: "main",
        git_commit_sha: "deadbeef",
        cwd: "/repo",
        local_username: "dev",
      },
    });
    await flushPendingTraces();

    const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
    const runs = Object.values(tree.data);
    expect(runs.length).toBeGreaterThan(3);

    // Serialize as the wire would, so undefined-valued keys are dropped.
    const seenTypes = new Set<string>();
    for (const run of runs) {
      const md = JSON.parse(JSON.stringify(meta(run))) as Record<string, unknown>;
      const runType = classify(run);
      seenTypes.add(runType);

      // Always-present identity keys with the frozen values.
      for (const [k, v] of ALWAYS) expect(md[k], `${k} on ${runType}`).toBe(v);
      // thread_id groups the whole tree on the conversation id.
      expect(md.thread_id).toBe(turn.conversationId);
      // Turn markers + versions land on every run (Cursor exposes turns).
      expect(md.turn_id).toBe(turn.buffer.generation_id);
      expect(md.turn_number).toBe(turn.turnNum);
      expect(md.ls_agent_runtime_version).toBe("3.7.19");
      expect(md.ls_integration_version).toBe("0.3.0");
      expect(md.repository_url).toBeDefined();
      expect(md.git_commit_sha).toBe("deadbeef");
      expect(md.cwd).toBe("/repo");

      // Leak rule: subagent-only keys only on subagent runs.
      if (runType !== "subagent") {
        expect(md, `ls_subagent_id leaked onto ${runType}`).not.toHaveProperty("ls_subagent_id");
        expect(md, `ls_subagent_type leaked onto ${runType}`).not.toHaveProperty(
          "ls_subagent_type",
        );
      } else {
        expect(md.ls_subagent_id).toBeDefined();
        expect(md.ls_subagent_type).toBe("explore");
      }
      // approval_policy is omitted for Cursor → must appear nowhere.
      expect(md).not.toHaveProperty("approval_policy");
    }

    // The fixture turn exercises root + llm + tool + subagent run types.
    expect(seenTypes).toEqual(new Set(["root", "llm", "tool", "subagent"]));
  });
});
