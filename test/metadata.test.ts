import { describe, it, expect } from "vitest";
import { join } from "node:path";
import type { Run } from "langsmith";
import {
  codingAgentMetadata,
  type CodingAgentMetadataOptions,
  type LSAgentType,
  skillNameFromTool,
} from "../src/metadata.js";
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
  const bare = () => codingAgentMetadata({ agentType: "root", threadId: "conv-1" });
  const withOpts = (opts: Partial<CodingAgentMetadataOptions>) =>
    codingAgentMetadata({ agentType: "root", threadId: "c", ...opts });

  it("stamps the frozen cursor identity block on every run", () => {
    expect(bare()).toMatchObject({
      ls_agent_purpose: "coding",
      ls_agent_type: "root",
      ls_integration: "cursor",
      ls_agent_runtime: "Cursor",
      ls_trace_schema_version: "coding-agent-v1",
      thread_id: "conv-1",
    });
    expect(bare()).not.toHaveProperty("ls_agent_kind");
  });

  it.each<LSAgentType>(["root", "subagent", "middleware", "compaction"])(
    "supports the %s agent type",
    (agentType) => {
      expect(codingAgentMetadata({ agentType, threadId: "c" }).ls_agent_type).toBe(agentType);
    },
  );

  it.each<[string, Partial<CodingAgentMetadataOptions>, unknown]>([
    ["turn_id", { turnId: "gen-9" }, "gen-9"],
    ["turn_number", { turnNumber: 3 }, 3],
    ["ls_agent_runtime_version", { runtimeVersion: "3.7.19" }, "3.7.19"],
    ["approval_policy", { approvalPolicy: "auto" }, "auto"],
    ["ls_subagent_id", { subagentId: "s1" }, "s1"],
    ["ls_subagent_type", { subagentType: "explore" }, "explore"],
    ["ls_skill_name", { skillName: "code-insights" }, "code-insights"],
  ])("emits %s when supplied, and omits the key when not", (key, opts, expected) => {
    expect(withOpts(opts)[key]).toBe(expected);
    expect(bare()).not.toHaveProperty(key);
  });

  it("clears the subagent keys on a child run without deleting them", () => {
    const child = withOpts({ clearSubagent: true });
    // Present-but-undefined shadows the parent's value; an absent key would not.
    expect("ls_subagent_id" in child).toBe(true);
    expect("ls_subagent_type" in child).toBe(true);
    expect(child.ls_subagent_id).toBeUndefined();
    expect(child.ls_subagent_type).toBeUndefined();
    expect(JSON.parse(JSON.stringify(child))).not.toHaveProperty("ls_subagent_id");
    expect(JSON.parse(JSON.stringify(child))).not.toHaveProperty("ls_subagent_type");
  });

  it.each<[string, string, string, string | undefined]>([
    ["omits ls_tool_name when the run name is the tool name", "Bash", "Bash", undefined],
    ["emits ls_tool_name when they differ", "Task", "Agent", "Task"],
  ])("%s", (_case, toolName, runName, expected) => {
    expect(withOpts({ toolName, runName }).ls_tool_name).toBe(expected);
  });

  it("lets base config win on a key collision", () => {
    const m = withOpts({ base: { thread_id: "override", extra: 1 } });
    expect(m.thread_id).toBe("override");
    expect(m.extra).toBe(1);
  });
});

// ─── Skill detection ──────────────────────────────────────────────────────────

/** One valid skill read, reused wherever the path is not what a case is testing. */
const SKILL_PATH = "/repo/skills/deploy/SKILL.md";

describe("skillNameFromTool", () => {
  const read = (input: unknown) => skillNameFromTool("read_file_v2", input);

  // The path is the whole subject, so each row is one path and what it yields.
  it.each<[string, string, string | undefined]>([
    ["posix", "/Users/u/.cursor/skills/example-pack/code-insights/SKILL.md", "code-insights"],
    ["windows", "C:\\repo\\skills\\pr-creation\\SKILL.md", "pr-creation"],
    ["non-ascii name", "/repo/skills/日本語/SKILL.md", "日本語"],
    // These two are redundant one at a time but not together: each alone proves
    // the `skills` ancestor is required.
    ["outside any skills directory", "/repo/SKILL.md", undefined],
    ["no skill directory of its own", "/repo/skills/SKILL.md", undefined],
    ["a backup beside the real one", "/repo/skills/deploy/SKILL.md.bak", undefined],
    ["traversal in place of the name", "/repo/skills/deploy/../SKILL.md", undefined],
  ])("%s: %s → %s", (_case, path, expected) => {
    expect(read({ path })).toBe(expected);
  });

  // Only the tool and the input key vary; every row carries the same valid path.
  it.each<[string, string, unknown, string | undefined]>([
    ["older captures spell it Read, keyed file_path", "Read", { file_path: SKILL_PATH }, "deploy"],
    ["subagent transcripts spell it ReadFile", "ReadFile", { path: SKILL_PATH }, "deploy"],
    ["a glob is not a read", "glob_file_search", { path: SKILL_PATH }, undefined],
    ["a grep is not a read", "Grep", { file_path: SKILL_PATH }, undefined],
  ])("%s", (_case, toolName, input, expected) => {
    expect(skillNameFromTool(toolName, input)).toBe(expected);
  });

  it.each<[string, unknown]>([
    ["a non-string path", { path: 42 }],
    ["no input at all", undefined],
  ])("yields nothing for %s", (_case, input) => {
    expect(read(input)).toBeUndefined();
  });

  it("stays fast on a path crafted to make a backtracking matcher blow up", () => {
    // CodeQL's js/polynomial-redos input: seconds for a regex, about 1ms split.
    const hostile = `/skills/${"/skills/!".repeat(20_000)}`;
    const started = performance.now();
    expect(skillNameFromTool("read_file_v2", { path: hostile })).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("ls_skill_name on the produced run tree", () => {
  it("tags the skill read and neither decoy beside it", async () => {
    const { finalized } = replayHookLog(SKILL_CAPTURE);
    const runs = await tracedRuns(finalized[0]);
    // Both decoys trace: the glob names SKILL.md, the second read is the same tool.
    expect(runs.some((r) => r.name === "glob_file_search")).toBe(true);
    expect(runs.filter((r) => r.name === "read_file_v2")).toHaveLength(2);
    expect(
      runs.filter((r) => meta(r).ls_skill_name).map((r) => [r.name, meta(r).ls_skill_name]),
    ).toEqual([["read_file_v2", "code-insights"]]);
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
