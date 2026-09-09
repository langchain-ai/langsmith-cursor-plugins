import { expect, it } from "vitest";
import { metadataForMode, runConfigForMode, MUTED_TRACE_CONTENT } from "../src/privacy.js";
import { codingAgentMetadata } from "../src/metadata.js";

it("passes full configs through without filtering", () => {
  const config = {
    inputs: { private: true },
    events: [{ private: true }],
    extra: { metadata: { cwd: "private" } },
  };
  expect(runConfigForMode(config)).toBe(config);
  expect(runConfigForMode(config, "full")).toBe(config);
});

it("projects trusted metadata despite custom collisions and drops untyped values", () => {
  const metadata = codingAgentMetadata({
    agentType: "root",
    threadId: "thread",
    turnId: "turn",
    turnNumber: 1,
    toolName: "Read",
    runName: "Read",
    runSpecific: { ls_model_name: "model", usage_metadata: { total_tokens: 2 } },
    base: {
      thread_id: "PRIVATE",
      ls_model_name: "PRIVATE",
      ls_tool_name: "PRIVATE",
      usage_metadata: { total_tokens: 9000 },
      ls_integration_version: "PRIVATE",
    },
  });
  const safe = metadataForMode(metadata, "metadata")!;
  expect(safe).toMatchObject({
    thread_id: "thread",
    ls_tool_name: "Read",
    ls_model_name: "model",
    usage_metadata: { total_tokens: 2 },
  });
  expect(JSON.stringify(safe)).not.toContain("PRIVATE");
  expect(JSON.stringify(safe)).not.toContain("9000");
  expect(
    metadataForMode(
      {
        thread_id: {},
        ls_model_name: [],
        turn_number: Infinity,
        usage_metadata: {
          input_tokens: 1,
          output_tokens: "PRIVATE",
          total_tokens: NaN,
          input_token_details: { cache_read: 2, cache_creation: -1, private: "PRIVATE" },
          output_token_details: { reasoning: 3, private: "PRIVATE" },
          extra: "PRIVATE",
        },
      },
      "metadata",
    ),
  ).toEqual({
    status: "running",
    ls_tracing_mode: "metadata",
    usage_metadata: {
      input_tokens: 1,
      input_token_details: { cache_read: 2 },
      output_token_details: { reasoning: 3 },
    },
  });
});

it("creates independent normal placeholder messages and preserves empty-error failure status", () => {
  const input = {
    inputs: { private: true },
    outputs: { private: true },
    error: "",
    end_time: 0,
    tags: ["PRIVATE"],
    events: [{ name: "PRIVATE" }],
    attachments: { private: "PRIVATE" },
    serialized: { private: true },
    extra: { metadata: { cwd: "PRIVATE", status: "PRIVATE" }, runtime: { private: true } },
  };
  const a = runConfigForMode(input, "metadata");
  const b = runConfigForMode(input, "metadata");
  expect(a.inputs).not.toBe(b.inputs);
  expect(a.inputs).toEqual({ messages: [{ role: "user", content: MUTED_TRACE_CONTENT }] });
  expect(a.outputs).toEqual({ messages: [{ role: "assistant", content: MUTED_TRACE_CONTENT }] });
  expect(a.extra.metadata.status).toBe("error");
  expect(a.error).toBeUndefined();
  expect(JSON.stringify(a)).not.toContain("PRIVATE");
  expect(input.inputs).toEqual({ private: true });
});
