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
    metadataForMode({ thread_id: {}, ls_model_name: [], turn_number: Infinity }, "metadata"),
  ).toEqual({ status: "running", ls_tracing_mode: "metadata" });
});

it.each([
  {},
  {
    input_tokens: 1,
    output_tokens: "allowed annotation",
    total_tokens: NaN,
    input_cost: 0.001,
    output_cost: -1,
    input_token_details: { cache_read: 2, image: { tiles: 4, annotation: "allowed image" } },
    output_token_details: { reasoning: 3, video: [1, "allowed video", null, {}] },
    costs: { currency: "USD", estimated: true, breakdown: {} },
    annotation: "ALLOWED_USAGE_MARKER",
    optional: null,
  },
])("preserves an open usage object unchanged: %j", (usage) => {
  const metadata = { usage_metadata: usage, custom: "PRIVATE", cwd: "PRIVATE" };
  const safe = metadataForMode(metadata, "metadata")!;
  expect(safe.usage_metadata).toBe(usage);
  expect(safe).toEqual({
    usage_metadata: usage,
    status: "running",
    ls_tracing_mode: "metadata",
  });
  const config = runConfigForMode({ extra: { metadata } }, "metadata");
  expect(config.extra.metadata.usage_metadata).toBe(usage);
  expect(JSON.parse(JSON.stringify(config)).extra.metadata.usage_metadata).toEqual(
    JSON.parse(JSON.stringify(usage)),
  );
  expect(JSON.stringify(config)).not.toContain("PRIVATE");
});

it.each([undefined, null, [], [1], "tokens", 42, false])(
  "rejects non-object outer usage metadata: %j",
  (usage) => {
    expect(metadataForMode({ usage_metadata: usage }, "metadata")).toEqual({
      status: "running",
      ls_tracing_mode: "metadata",
    });
  },
);

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
