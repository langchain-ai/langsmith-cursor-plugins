import { describe, expect, it } from "vitest";
import type { Run } from "langsmith";
import {
  buildTurnRuns,
  flushPendingTraces,
  initTracing,
  metadataReplicas,
} from "../src/langsmith.js";
import { mockClient } from "./utils/mock_client.js";
import { getAssumedTreeFromCalls } from "./utils/tree.js";
import type { TurnBuffer } from "../src/types.js";
import { loadState } from "../src/state.js";
import { reduceBeforeSubmitPrompt, reducePostToolUse, reduceStop } from "../src/reducer.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function metadata(run: Run): Record<string, unknown> {
  return (run.extra as { metadata?: Record<string, unknown> })?.metadata ?? {};
}

describe("metadata tracing mode", () => {
  it("removes replica updates and unknown fields", () => {
    initTracing(undefined, undefined, [
      {
        apiUrl: "https://replica.example",
        apiKey: "key",
        projectName: "project",
        updates: { inputs: { secret: true }, extra: { metadata: { secret: true } } },
        custom: "secret",
      } as never,
    ]);
    expect(metadataReplicas()).toEqual([
      { apiUrl: "https://replica.example", apiKey: "key", projectName: "project" },
    ]);
  });

  it("preserves topology and timings without content or disallowed metadata", async () => {
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, true, undefined, client);
    const buffer: TurnBuffer = {
      generation_id: "secret-id",
      tracing_mode: "metadata",
      startMs: 1000,
      model: "claude-4.6-sonnet",
      prompt: "secret prompt",
      finalText: "secret result",
      status: "completed",
      usage: { input_tokens: 3, output_tokens: 2 },
      thoughts: [{ text: "secret thought" }],
      tools: [
        {
          tool_use_id: "secret-tool-id",
          name: "Read",
          input: { path: "/secret" },
          output: "secret output",
          endMs: 2000,
          duration: 0.5,
        },
      ],
      subagents: [
        {
          subagent_id: "secret-subagent-id",
          subagent_type: "explore",
          task: "secret task",
          startMs: 2100,
          endMs: 2500,
          status: "secret failure details",
          tools: [],
        },
      ],
    };

    await buildTurnRuns({
      buffer,
      conversationId: "thread",
      turnNum: 4,
      project: "test",
      userEmail: "secret@example.com",
      workspaceRoots: ["/secret"],
      customMetadata: { custom: "secret" },
      systemPrompt: "secret system prompt",
    });
    await flushPendingTraces();

    const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
    const runs = Object.values(tree.data);
    expect(runs.map((run) => run.run_type).sort()).toEqual([
      "chain",
      "chain",
      "llm",
      "llm",
      "llm",
      "tool",
    ]);
    for (const run of runs) {
      expect(run.tags ?? []).toEqual([]);
      expect(run.inputs).toEqual({});
      expect(run.outputs).toEqual({});
      expect(run.error).toBeUndefined();
      expect(metadata(run).ls_tracing_mode).toBe("metadata");
      const allowed = new Set([
        "thread_id",
        "turn_number",
        "status",
        "ls_model_name",
        "ls_tool_name",
        "usage_metadata",
        "ls_agent_purpose",
        "ls_agent_type",
        "ls_agent_runtime",
        "ls_tracing_mode",
      ]);
      expect(Object.keys(metadata(run)).every((key) => allowed.has(key))).toBe(true);
      expect(metadata(run).ls_tracing_mode).toBe("metadata");
      expect(JSON.stringify(run)).not.toContain("secret");
    }
    expect(runs.some((run) => metadata(run).status === "secret failure details")).toBe(false);
    const subagent = runs.find((run) => run.name === "explore Subagent")!;
    const descendants = runs.filter((run) => run.parent_run_id === subagent.id);
    expect(descendants.every((run) => metadata(run).ls_agent_type === "subagent")).toBe(true);
    const tool = runs.find((run) => run.run_type === "tool")!;
    expect(tool.name).toBe("Read");
    expect(Date.parse(tool.start_time as string)).toBe(1500);
    expect(tool.end_time).toBeDefined();
  });

  it("reduces and builds a corrupt mixed state without exposing retained or new content", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "corrupt-state-")), "state.json");
    writeFileSync(
      file,
      JSON.stringify({
        retained: {
          turns: {
            old: {
              generation_id: "old",
              tracing_mode: "full",
              startMs: 1,
              prompt: "retained secret",
              tools: [],
              thoughts: [],
              subagents: [],
            },
          },
          turn_count: 0,
          updated: "t",
        },
        invalid: { turns: { broken: { prompt: "nested secret" } } },
      }),
    );
    let state = loadState(file);
    state = reduceBeforeSubmitPrompt(
      state,
      {
        hook_event_name: "beforeSubmitPrompt",
        conversation_id: "thread",
        generation_id: "turn",
        model: "cursor-small",
        prompt: "new prompt secret",
      },
      1000,
    );
    state = reducePostToolUse(
      state,
      {
        hook_event_name: "postToolUse",
        conversation_id: "thread",
        generation_id: "turn",
        model: "cursor-small",
        tool_use_id: "secret-id",
        tool_name: "Read",
        tool_input: { path: "tool input secret" },
        tool_output: "tool output secret",
      },
      1500,
    );
    const result = reduceStop(
      state,
      {
        hook_event_name: "stop",
        conversation_id: "thread",
        generation_id: "turn",
        model: "cursor-small",
        status: "completed",
      },
      2000,
    );
    expect(result.buffer?.tracing_mode).toBe("metadata");
    expect(JSON.stringify(result)).not.toContain("secret");

    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, true, undefined, client);
    await buildTurnRuns({
      buffer: result.buffer!,
      conversationId: "thread",
      turnNum: result.turnNum,
      project: "test",
    });
    await flushPendingTraces();

    const payload = JSON.stringify(callSpy.mock.calls);
    expect(payload).not.toContain("secret");
    const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
    for (const run of Object.values(tree.data)) {
      expect(run.inputs).toEqual({});
      expect(run.outputs).toEqual({});
      expect(metadata(run).ls_tracing_mode).toBe("metadata");
    }
  });

  it("lets conversation metadata dominate an otherwise valid full turn through stop upload", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "mixed-state-")), "state.json");
    writeFileSync(
      file,
      JSON.stringify({
        thread: {
          tracing: "metadata",
          turn_count: 2,
          updated: "2026-01-01T00:00:00.000Z",
          turns: {
            turn: {
              generation_id: "turn",
              tracing_mode: "full",
              startMs: 1000,
              prompt: "retained prompt secret",
              finalText: "retained answer secret",
              status: "retained status secret",
              model: "claude-4.6-sonnet",
              usage: { input_tokens: 3, output_tokens: 2 },
              thoughts: [{ text: "retained thought secret" }],
              tools: [
                {
                  tool_use_id: "retained tool id secret",
                  name: "Read",
                  input: { path: "retained input secret" },
                  output: "retained output secret",
                  error: "retained error secret",
                  endMs: 1500,
                  duration: 0.25,
                },
              ],
              subagents: [
                {
                  subagent_id: "retained subagent id secret",
                  subagent_type: "explore",
                  task: "retained task secret",
                  description: "retained description secret",
                  resultText: "retained result secret",
                  systemPrompt: "retained system secret",
                  status: "retained subagent status secret",
                  startMs: 1600,
                  endMs: 1800,
                  tools: [],
                },
              ],
            },
          },
        },
      }),
    );

    const state = loadState(file);
    expect(state.thread.turns.turn.tracing_mode).toBe("metadata");
    expect(JSON.stringify(state)).not.toContain("secret");
    const result = reduceStop(
      state,
      {
        hook_event_name: "stop",
        conversation_id: "thread",
        generation_id: "turn",
        model: "cursor-small",
        status: "incoming stop secret",
      },
      2000,
    );
    expect(result.buffer?.tracing_mode).toBe("metadata");
    expect(JSON.stringify(result)).not.toContain("secret");

    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, true, undefined, client);
    await buildTurnRuns({
      buffer: result.buffer!,
      conversationId: "thread",
      turnNum: result.turnNum,
      project: "test",
      attachments: [{ type: "text", text: "incoming attachment secret" }],
      systemPrompt: "incoming system secret",
      steps: [{ type: "thinking", text: "incoming step secret" }],
    });
    await flushPendingTraces();

    const payload = JSON.stringify(callSpy.mock.calls);
    expect(payload).not.toContain("secret");
    const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
    for (const run of Object.values(tree.data)) {
      expect(run.inputs).toEqual({});
      expect(run.outputs).toEqual({});
      expect(metadata(run).ls_tracing_mode).toBe("metadata");
    }
  });

  it("clamps a metadata tool start to the turn root start", async () => {
    const { client, callSpy } = mockClient();
    initTracing(undefined, undefined, undefined, true, undefined, client);
    const buffer: TurnBuffer = {
      generation_id: "turn",
      tracing_mode: "metadata",
      startMs: 1000,
      thoughts: [],
      subagents: [],
      tools: [
        {
          tool_use_id: "",
          name: "Shell",
          input: {},
          duration: 10,
          endMs: 2000,
        },
      ],
    };

    await buildTurnRuns({ buffer, conversationId: "thread", turnNum: 1, project: "test" });
    await flushPendingTraces();

    const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
    const tool = Object.values(tree.data).find((run) => run.run_type === "tool")!;
    expect(Date.parse(tool.start_time as string)).toBe(1000);
  });
});
