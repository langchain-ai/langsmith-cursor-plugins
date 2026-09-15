import { describe, it, expect } from "vitest";
import { join } from "node:path";
import type { Run } from "langsmith";
import { codingAgentMetadata, type LSAgentType, skillNameFromTool } from "../src/metadata.js";
import { replayHookLog, type FinalizedTurn } from "./utils/replay.js";
import { mockClient } from "./utils/mock_client.js";
import { getAssumedTreeFromCalls } from "./utils/tree.js";
import { initTracing, buildTurnRuns, flushPendingTraces } from "../src/langsmith.js";

const CAPTURE = join(process.cwd(), "test/fixtures/cursor-hooks.jsonl");
const SKILL_CAPTURE = join(process.cwd(), "test/fixtures/cursor-skill-read.jsonl");

function meta(run: Run): Record<string, unknown> {
  return (run.extra as { metadata?: Record<string, unknown> })?.metadata ?? {};
}

/** Traces one replayed turn against a mock client and returns the runs it posted. */
async function tracedRuns(
  turn: FinalizedTurn,
  extra: Partial<Parameters<typeof buildTurnRuns>[0]> = {},
): Promise<Run[]> {
  const { client, callSpy } = mockClient();
  initTracing(undefined, undefined, undefined, true, undefined, client);
  await buildTurnRuns({
    buffer: turn.buffer,
    conversationId: turn.conversationId,
    turnNum: turn.turnNum,
    project: "test",
    ...extra,
  });
  await flushPendingTraces();
  const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
  return Object.values(tree.data);
}

// ─── Helper unit tests ────────────────────────────────────────────────────────

describe("codingAgentMetadata helper", () => {
  it("always emits the identity block with the frozen cursor literals", () => {
    const m = codingAgentMetadata({ agentType: "root", threadId: "conv-1" });
    expect(m.ls_agent_purpose).toBe("coding");
    expect(m.ls_agent_type).toBe("root");
    expect(m.ls_agent_kind).toBeUndefined();
    expect(m.ls_integration).toBe("cursor");
    expect(m.ls_agent_runtime).toBe("Cursor");
    expect(m.ls_trace_schema_version).toBe("coding-agent-v1");
    expect(m.thread_id).toBe("conv-1");
  });

  it.each<LSAgentType>(["root", "subagent", "middleware", "compaction"])(
    "supports the %s agent type",
    (agentType) => {
      const m = codingAgentMetadata({ agentType, threadId: "c" });
      expect(m.ls_agent_type).toBe(agentType);
    },
  );

  it("emits turn + runtime version keys when known, omits when not", () => {
    const m = codingAgentMetadata({
      agentType: "root",
      threadId: "c",
      turnId: "gen-9",
      turnNumber: 3,
      runtimeVersion: "3.7.19",
    });
    expect(m.turn_id).toBe("gen-9");
    expect(m.turn_number).toBe(3);
    expect(m.ls_agent_runtime_version).toBe("3.7.19");

    const bare = codingAgentMetadata({ agentType: "root", threadId: "c" });
    expect("turn_id" in bare).toBe(false);
    expect("turn_number" in bare).toBe(false);
    expect("ls_agent_runtime_version" in bare).toBe(false);
  });

  it("emits subagent identity keys, and clearSubagent nulls them out (undefined)", () => {
    const sub = codingAgentMetadata({
      agentType: "subagent",
      threadId: "c",
      subagentId: "s1",
      subagentType: "explore",
    });
    expect(sub.ls_subagent_id).toBe("s1");
    expect(sub.ls_subagent_type).toBe("explore");

    const child = codingAgentMetadata({
      agentType: "subagent",
      threadId: "c",
      clearSubagent: true,
    });
    // Present-but-undefined → dropped on JSON serialization, never reaches the server.
    expect(child.ls_subagent_id).toBeUndefined();
    expect(child.ls_subagent_type).toBeUndefined();
    expect(JSON.parse(JSON.stringify(child))).not.toHaveProperty("ls_subagent_id");
  });

  it("emits ls_tool_name only when the native tool name differs from the run name", () => {
    expect(
      codingAgentMetadata({ agentType: "root", threadId: "c", toolName: "Bash", runName: "Bash" })
        .ls_tool_name,
    ).toBeUndefined();
    expect(
      codingAgentMetadata({ agentType: "root", threadId: "c", toolName: "Task", runName: "Agent" })
        .ls_tool_name,
    ).toBe("Task");
  });

  it("lets base (user config) win on key collision", () => {
    const m = codingAgentMetadata({
      agentType: "root",
      threadId: "c",
      base: { thread_id: "override", extra: 1 },
    });
    expect(m.thread_id).toBe("override");
    expect(m.extra).toBe(1);
  });
});

// ─── Skill detection ──────────────────────────────────────────────────────────

describe("skillNameFromTool", () => {
  it.each<[string, string, unknown, string | undefined]>([
    [
      "names the skill a posix SKILL.md read loaded",
      "read_file_v2",
      { path: "/Users/u/.cursor/skills/langster/code-insights/SKILL.md" },
      "code-insights",
    ],
    [
      "names the skill a windows SKILL.md read loaded",
      "read_file_v2",
      { path: "C:\\repo\\skills\\pr-creation\\SKILL.md" },
      "pr-creation",
    ],
    [
      "still reads the pre-3.20 tool and path key",
      "Read",
      { file_path: "/repo/.claude/skills/deploy/SKILL.md" },
      "deploy",
    ],
    [
      "ignores a glob that names SKILL.md while hunting for it",
      "glob_file_search",
      { globPattern: "**/code-insights/SKILL.md" },
      undefined,
    ],
    [
      "ignores a search whose args carry a skill path",
      "Grep",
      { pattern: "x", file_path: "/repo/skills/deploy/SKILL.md" },
      undefined,
    ],
    [
      "ignores an ordinary source read",
      "read_file_v2",
      { path: "/repo/src/metadata.ts" },
      undefined,
    ],
    [
      "ignores a SKILL.md outside any skills directory",
      "read_file_v2",
      { path: "/repo/SKILL.md" },
      undefined,
    ],
    [
      "ignores a SKILL.md with no skill directory of its own",
      "read_file_v2",
      { path: "/repo/skills/SKILL.md" },
      undefined,
    ],
    [
      "ignores a backup alongside a SKILL.md",
      "read_file_v2",
      { path: "/repo/skills/deploy/SKILL.md.bak" },
      undefined,
    ],
    [
      "ignores a traversal segment in place of the skill name",
      "read_file_v2",
      { path: "/repo/skills/deploy/../SKILL.md" },
      undefined,
    ],
    ["ignores a non-string path", "read_file_v2", { path: 42 }, undefined],
    ["ignores a call with no input", "read_file_v2", undefined, undefined],
  ])("%s", (_case, toolName, toolInput, expected) => {
    expect(skillNameFromTool(toolName, toolInput)).toBe(expected);
  });

  it("stays fast on a path crafted to make a backtracking matcher blow up", () => {
    // CodeQL's js/polynomial-redos input. A backtracking path matcher needs
    // seconds here; splitting needs about a millisecond.
    const hostile = `/skills/${"/skills/!".repeat(20_000)}`;
    const started = performance.now();
    expect(skillNameFromTool("read_file_v2", { path: hostile })).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("ls_skill_name on the produced run tree", () => {
  it("tags only the skill read in a turn that also globbed for SKILL.md", async () => {
    const { finalized } = replayHookLog(SKILL_CAPTURE);
    const runs = await tracedRuns(finalized[0]);
    expect(runs.some((r) => r.name === "glob_file_search")).toBe(true);
    expect(
      runs.filter((r) => meta(r).ls_skill_name).map((r) => [r.name, meta(r).ls_skill_name]),
    ).toEqual([["read_file_v2", "langster-code-insights"]]);
  });

  it("tags nothing in a capture whose reads are all ordinary files", async () => {
    const { finalized } = replayHookLog(CAPTURE);
    const runs: Run[] = [];
    for (const turn of finalized) runs.push(...(await tracedRuns(turn)));
    expect(runs.some((r) => r.name === "Read")).toBe(true);
    expect(runs.filter((r) => meta(r).ls_skill_name)).toEqual([]);
  });
});

// ─── Contract gate against a real fixture replay ──────────────────────────────
// Mirrors validate-thread.mjs's classify + required-key/leak rules in-process.

const ALWAYS = [
  ["ls_agent_purpose", "coding"],
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
    const { finalized } = replayHookLog(CAPTURE);
    const turn = finalized.find((f) => f.buffer.subagents.length > 0)!; // exercises every run type

    const runs = await tracedRuns(turn, {
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
    const byId = new Map(runs.map((run) => [run.id, run]));
    expect(runs.length).toBeGreaterThan(3);

    // Serialize as the wire would, so undefined-valued keys are dropped.
    const seenTypes = new Set<string>();
    for (const run of runs) {
      const md = JSON.parse(JSON.stringify(meta(run))) as Record<string, unknown>;
      const runType = classify(run);
      seenTypes.add(runType);

      // Always-present identity keys with the frozen values.
      for (const [k, v] of ALWAYS) expect(md[k], `${k} on ${runType}`).toBe(v);
      expect(md).not.toHaveProperty("ls_agent_kind");

      let ownerType = runType === "subagent" ? "subagent" : "root";
      let parent = run.parent_run_id ? byId.get(run.parent_run_id) : undefined;
      while (parent) {
        if (classify(parent) === "subagent") ownerType = "subagent";
        parent = parent.parent_run_id ? byId.get(parent.parent_run_id) : undefined;
      }
      expect(md.ls_agent_type, `ls_agent_type on ${runType}`).toBe(ownerType);

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
