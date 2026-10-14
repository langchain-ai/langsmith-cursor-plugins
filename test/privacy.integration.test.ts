import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: () => {
    const child = new EventEmitter();
    setImmediate(() => child.emit("error", new Error("worker launch is mocked")));
    return child;
  },
}));

type Payload = Record<string, any>;
type Operation = { action: "post" | "patch"; payload: Payload };
type RequestBody = {
  url: URL;
  method: string;
  raw: string;
  operations: Operation[];
  headers: Headers;
};

const API = "http://privacy.test";
const FORBIDDEN = "FORBIDDEN_PRIVACY_MARKER";
const REVISION = `${FORBIDDEN}_revision`;
const WORKSPACE = `${FORBIDDEN}_workspace`;
const CI_SHA = `${FORBIDDEN}_ci`;
const SECRET = "custom-sensitive-model-name";

let requests: RequestBody[];
let allowedOrigins: string[];

// Usage content is explicitly allowed, unlike general custom metadata/content.
const allowedUsage = {
  input_tokens: 2,
  output_tokens: 3,
  total_tokens: 5,
  input_cost: 0.001,
  output_cost: 0.002,
  input_token_details: { cache_read: 4, image: { tiles: 2, annotation: "ALLOWED_IMAGE" } },
  output_token_details: { video: { frames: 8, annotations: ["ALLOWED_VIDEO", null, {}] } },
  costs: { currency: "USD", estimated: true, breakdown: {} },
  annotation: "ALLOWED_USAGE_MARKER",
  optional: null,
};

const allowedMetadata = {
  thread_id: "thread",
  turn_id: "turn",
  turn_number: 2,
  ls_agent_type: "root",
  ls_agent_purpose: "coding",
  ls_agent_runtime: "Cursor",
  ls_agent_runtime_version: "test-runtime",
  ls_integration: "cursor",
  ls_integration_version: "test-integration",
  ls_trace_schema_version: "coding-agent-v1",
  ls_model_name: SECRET,
  ls_tool_name: "Bash",
  usage_metadata: allowedUsage,
  ls_subagent_id: "subagent",
  ls_subagent_type: "Explore",
};

const captureFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  // Even shared/fallback clients cannot make an external request.
  expect(allowedOrigins).toContain(url.origin);
  if (url.pathname === "/info") return Response.json({});
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const raw =
    init?.body != null
      ? await new Response(init.body).text()
      : input instanceof Request
        ? await input.text()
        : "";
  expect(method).toMatch(/^(POST|PATCH)$/);
  expect(url.pathname).toMatch(/\/runs(?:\/batch|\/[\da-f-]+)?$/);
  const operations: Operation[] = url.pathname.endsWith("/runs/batch")
    ? [
        ...((JSON.parse(raw).post ?? []) as Payload[]).map((payload) => ({
          action: "post" as const,
          payload,
        })),
        ...((JSON.parse(raw).patch ?? []) as Payload[]).map((payload) => ({
          action: "patch" as const,
          payload,
        })),
      ]
    : [{ action: method === "POST" ? "post" : "patch", payload: JSON.parse(raw) }];
  requests.push({ url, method, raw, operations, headers });
  return Response.json({});
};

beforeEach(async () => {
  // getRuntimeEnvironment/getShas and Client metadata are cached by the SDK.
  // Install markers BEFORE importing/constructing any real SDK objects, and
  // isolate its shared client/cache from other cases (and ambient tracing env).
  vi.resetModules();
  for (const key of Object.keys(process.env)) {
    if (key === "LANGSMITH_CURSOR_LOG_FILE") continue;
    if (/^(LANGCHAIN_|LANGSMITH_|CC_LANGSMITH_)/.test(key) || key === "TRACE_TO_LANGSMITH") {
      vi.stubEnv(key, undefined);
    }
  }
  vi.stubEnv("LANGCHAIN_REVISION_ID", REVISION);
  vi.stubEnv("LANGSMITH_WORKSPACE_ID", WORKSPACE);
  vi.stubEnv("CI_COMMIT_SHA", CI_SHA);
  vi.stubEnv("LANGSMITH_ENDPOINT", API);
  vi.stubEnv("LANGSMITH_API_KEY", "test-only-key");
  vi.stubEnv("LANGSMITH_TRACING_MODE", "langsmith");
  vi.stubEnv("LANGSMITH_TRACING_SAMPLING_RATE", "1");
  vi.stubEnv("LANGSMITH_CURSOR_INTEGRATION_VERSION", "plugin-version");
  vi.stubGlobal("fetch", captureFetch);
  requests = [];
  allowedOrigins = [API];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function expectMutedContent(payload: Payload, excludeInputs = false): void {
  if (excludeInputs) {
    expect.soft(payload.inputs).toBeUndefined();
  } else {
    expect.soft(payload.inputs).toEqual({
      messages: [
        {
          role: "user",
          content: "[LangSmith system notice: content omitted because tracing is muted.]",
        },
      ],
    });
  }
  if (excludeInputs && payload.outputs === undefined) return;
  expect.soft(payload.outputs).toEqual({
    messages: [
      {
        role: "assistant",
        content: "[LangSmith system notice: content omitted because tracing is muted.]",
      },
    ],
  });
}

function replicaUpdates(): Payload {
  return {
    inputs: { private: `${FORBIDDEN}_replica_input` },
    outputs: { private: `${FORBIDDEN}_replica_output` },
    error: `${FORBIDDEN}_replica_error`,
    tags: [`${FORBIDDEN}_replica_tag`],
    extra: {
      metadata: { custom: `${FORBIDDEN}_replica_metadata` },
      runtime: { private: FORBIDDEN },
    },
  };
}

describe("overlapping Cursor launch privacy", { timeout: 60_000 }, () => {
  it.each([
    "conversation-id",
    "muted-generation",
    "full-generation",
    "full-tool-link",
    "conflicting-proof",
  ] as const)("uses %s evidence without changing the latest-turn tree", async (evidence) => {
    allowedOrigins = [API, "http://127.0.0.1"];
    const {
      reduceBeforeSubmitPrompt,
      reducePostToolUse,
      reduceSubagentStart,
      reduceSubagentStop,
      reduceStop,
    } = await import("../src/reducer.js");
    const { sendTurn } = await import("./utils/engine.js");
    const sentinel = "PRIVATE_OVERLAPPING_SUBAGENT";
    const base = { conversation_id: "parent", generation_id: "genA", model: "default" };
    let state = reduceBeforeSubmitPrompt(
      {},
      {
        ...base,
        hook_event_name: "beforeSubmitPrompt",
        prompt: "muted A",
      },
      1000,
      "metadata",
    );
    state = reduceBeforeSubmitPrompt(
      state,
      {
        ...base,
        generation_id: "genB",
        hook_event_name: "beforeSubmitPrompt",
        prompt: "public B",
      },
      2000,
      "full",
    );
    if (evidence === "full-tool-link" || evidence === "conflicting-proof") {
      state = reducePostToolUse(
        state,
        {
          ...base,
          generation_id: "genB",
          hook_event_name: "postToolUse",
          tool_name: "Task",
          tool_use_id: "launch-link",
          tool_input: {},
          tool_output: "",
          duration: 0,
        },
        2100,
      );
    }
    state = reduceSubagentStart(
      state,
      {
        ...base,
        // Real fixtures often repeat conversation_id here; it is NOT a generation proof.
        generation_id:
          evidence === "full-generation"
            ? "genB"
            : evidence === "muted-generation" || evidence === "conflicting-proof"
              ? "genA"
              : "parent",
        parent_conversation_id: "parent",
        session_id: "parent",
        tool_call_id: "launch-link",
        hook_event_name: "subagentStart",
        subagent_id: "sub",
        subagent_type: "explore",
        task: sentinel,
      },
      2200,
    );
    expect(state.parent.turns.genA.subagents).toHaveLength(0);
    expect(state.parent.turns.genB.subagents).toHaveLength(1);
    const fullProof = evidence === "full-generation" || evidence === "full-tool-link";
    expect(state.parent.turns.genB.subagents[0].tracingMode).toBe(fullProof ? "full" : "metadata");
    state = reducePostToolUse(
      state,
      {
        ...base,
        conversation_id: "child",
        generation_id: "childgen",
        hook_event_name: "postToolUse",
        tool_name: "Read",
        tool_use_id: "read",
        tool_input: { path: sentinel },
        tool_output: sentinel,
      },
      2300,
    );
    state = reduceSubagentStop(
      state,
      {
        ...base,
        hook_event_name: "subagentStop",
        subagent_id: "sub",
        subagent_type: "explore",
        status: "completed",
        description: sentinel,
      },
      2400,
      { childConversationId: "child", resultText: sentinel },
    );
    const stopped = reduceStop(
      state,
      {
        ...base,
        generation_id: "genB",
        hook_event_name: "stop",
        status: "completed",
      },
      2500,
    );
    expect(stopped.state.parent.turns.genA.tracingMode).toBe("metadata");
    expect(stopped.state.child).toBeUndefined();
    const buffer = stopped.buffer!;
    buffer.subagents[0].systemPrompt = sentinel;
    const shapes = [];
    // Compare privacy-only rendering to the old full serialization, not a different join.
    for (const baseline of [false, true]) {
      requests = [];
      await sendTurn(
        captureFetch,
        {
          buffer: {
            ...buffer,
            subagents: buffer.subagents.map((sub) => ({
              ...sub,
              tracingMode: baseline ? "full" : sub.tracingMode,
            })),
          },
          conversationId: "parent",
          turnNum: 1,
          project: "test",
        },
        false,
      );
      const posts = requests
        .flatMap((r) => r.operations)
        .filter((op) => op.action === "post")
        .map((op) => op.payload);
      const root = posts.find((r) => !r.parent_run_id)!;
      const sub = posts.find((r) => r.name === "explore Subagent")!;
      expect(sub.parent_run_id).toBe(root.id);
      expect(posts.every((r) => r.trace_id === root.id)).toBe(true);
      expect(posts.every((r) => r.dotted_order.endsWith(r.id))).toBe(true);
      expect(posts.filter((r) => r.parent_run_id === sub.id)).toHaveLength(3);
      shapes.push(
        posts.map((r) => [
          r.name,
          r.run_type,
          r.start_time,
          posts.findIndex((parent) => parent.id === r.parent_run_id),
          r.dotted_order.split(".").length,
        ]),
      );
      const wire = requests.map((r) => r.raw).join("\n");
      if (baseline || fullProof) expect(wire).toContain(sentinel);
      else {
        expect(wire).not.toContain(sentinel);
        expect(wire).toContain("public B");
        for (const r of posts.filter((r) => r.id === sub.id || r.parent_run_id === sub.id)) {
          expectMutedContent(r);
          expect(r.extra.metadata.ls_tracing_mode).toBe("metadata");
        }
      }
    }
    expect(shapes[0]).toEqual(shapes[1]);
  });
});

// Project/home root file -> real prompt snapshot -> existing stop reducer -> actual builder/SDK wire.
// No injected Client: credentials, destinations and anonymizer all come from loadConfig.
describe.each(["project", "home"] as const)("common %s root config", (scope) => {
  describe("at the wire through the saved uploader", { timeout: 60_000 }, () => {
    it.each([
      "muted-redact-off",
      "full-redact-off",
      "full-file-rules",
      "keyless-muted-redact-off",
      "keyless-full-redact-off",
    ] as const)("%s", async (scenario) => {
      allowedOrigins = [API, "http://replica.test"];
      vi.stubEnv("LANGSMITH_ENDPOINT", undefined);
      vi.stubEnv("LANGSMITH_API_KEY", undefined);
      // No env override: this fixture exercises file enablement.
      vi.stubEnv("TRACE_TO_LANGSMITH", undefined);
      const home = mkdtempSync(join(tmpdir(), "cursor-config-wire-"));
      vi.stubEnv("HOME", home);
      vi.stubEnv("LANGSMITH_CURSOR_LOG_FILE", join(home, "hook.log"));
      const cwd = join(home, "workspace");
      mkdirSync(cwd);
      mkdirSync(join(home, ".cursor"));
      const keyless = scenario.startsWith("keyless-");
      const muted = scenario.includes("muted-redact-off");
      const rules = scenario === "full-file-rules";
      const collisions = Object.fromEntries(
        Object.keys(allowedMetadata).map((key) => [key, `${FORBIDDEN}_${key}`]),
      );
      writeFileSync(
        join(home, ".cursor", "langsmith.json"),
        JSON.stringify({
          metadata: { ...collisions, userOnly: FORBIDDEN, nested: { user: true } },
        }),
      );
      // The retired home filename must not affect routing, privacy or file validity.
      if (scope === "home") {
        writeFileSync(
          join(home, "langsmith-plugins.json"),
          rules
            ? "{malformed"
            : JSON.stringify({ enabled: false, defaultMuted: !muted, api_url: "http://old.test" }),
        );
      }
      // Unrelated application config must not disable tracing or invalidate plugin settings.
      writeFileSync(
        join(cwd, "langsmith.json"),
        rules ? "{malformed" : JSON.stringify({ enabled: false, defaultMuted: !muted }),
      );
      writeFileSync(
        scope === "home"
          ? join(home, ".langsmith-plugins.json")
          : join(cwd, "langsmith-plugins.json"),
        JSON.stringify({
          enabled: true,
          defaultMuted: muted,
          ...(keyless ? {} : { api_key: "primary-file-key" }),
          api_url: API,
          project: "primary-file-project",
          redact: rules,
          redact_extra_rules: [{ pattern: "file-sensitive-[0-9]+", replace: "[file-redacted]" }],
          metadata: { ...collisions, rootOnly: FORBIDDEN, nested: { root: true } },
          replicas: [
            // The keyless primary's replica must inherit the private file URL, not the SDK default.
            keyless
              ? { api_key: "inherited-replica-key", project: "inherited-replica-project" }
              : {},
            {
              api_url: "http://replica.test",
              api_key: "replica-file-key",
              project: "replica-file-project",
              updates: replicaUpdates(),
            },
          ],
          attachments: false,
          system_prompt: false,
        }),
      );
      try {
        const { handlePromptSubmit } = await import("../src/prompt-control.js");
        const { loadConfig } = await import("../src/config.js");
        const { loadState } = await import("./utils/state.js");
        const { reduceStop } = await import("../src/reducer.js");
        const { runEngineWorker, saveTurnForUpload } = await import("../src/tracing-engine.js");
        const input = {
          conversation_id: "file-thread",
          generation_id: "file-turn",
          workspace_roots: [cwd],
          model: "claude-4.6-sonnet",
          hook_event_name: "beforeSubmitPrompt" as const,
          prompt: `${FORBIDDEN}_prompt file-sensitive-123 file-sensitive-456`,
        };
        expect(await handlePromptSubmit(input)).toEqual({ continue: true });
        const cfg = loadConfig({ cwd });
        const { initHook } = await import("../src/utils/hook-init.js");
        // Exercise the real event/Stop master-and-credentials gate, including home-only replicas.
        expect(initHook(cwd)).toEqual(cfg);
        expect(cfg.apiKey).toBe(keyless ? "" : "primary-file-key");
        expect(cfg.redact).toBe(rules);
        expect(cfg.customMetadata).toMatchObject({
          userOnly: FORBIDDEN,
          rootOnly: FORBIDDEN,
          nested: scope === "home" ? { user: true } : { root: true },
        });
        const state = loadState(cfg.stateFilePath);
        const stopped = reduceStop(
          state,
          { ...input, hook_event_name: "stop", status: "completed" },
          Date.now(),
        );
        expect(stopped.buffer?.tracingMode).toBe(muted ? "metadata" : "full");
        await saveTurnForUpload(cfg, {
          buffer: { ...stopped.buffer!, finalText: "file-sensitive-789" },
          conversationId: input.conversation_id,
          turnNum: stopped.turnNum,
          project: cfg.project,
          customMetadata: cfg.customMetadata,
        });
        await runEngineWorker(cfg, input.conversation_id);
        expect(new Set(requests.map((r) => r.url.origin))).toEqual(new Set(allowedOrigins));
        for (const request of requests) {
          const replica = request.url.origin === "http://replica.test";
          expect(request.headers.get("x-api-key")).toBe(
            replica ? "replica-file-key" : keyless ? "inherited-replica-key" : "primary-file-key",
          );
          expect(request.operations.length).toBeGreaterThan(0);
          for (const { payload, action } of request.operations) {
            expect(payload.session_name).toBe(
              replica
                ? "replica-file-project"
                : keyless
                  ? "inherited-replica-project"
                  : "primary-file-project",
            );
            if (muted) {
              expectMutedContent(payload, action === "patch");
              expect(payload.extra.metadata).toMatchObject({
                thread_id: "file-thread",
                turn_id: "file-turn",
                ls_tracing_mode: "metadata",
              });
            }
          }
        }
        const wire = requests.map((r) => r.raw).join("\n");
        if (muted) {
          expect(wire).not.toContain(FORBIDDEN);
          expect(wire).not.toContain("file-sensitive-");
        } else {
          expect(wire).toContain(FORBIDDEN);
          if (rules) {
            expect(wire).not.toContain("file-sensitive-");
            expect(wire).toContain("[file-redacted]");
          } else expect(wire).toContain("file-sensitive-123");
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });
});
