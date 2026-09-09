import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client as SDKClient, RunTreeConfig } from "langsmith";

// No SDK mocks: capture only the HTTP boundary, after SDK enrichment,
// anonymization, batching and (for multipart) splitting into individual parts.
type Transport = "non-batched" | "json-batch" | "multipart";
type Status = "running" | "completed" | "error";
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
const REDACTED = "[private-model]";
const transports: Transport[] = ["non-batched", "json-batch", "multipart"];

let Client: typeof import("langsmith").Client;
let RunTree: typeof import("langsmith").RunTree;
let createRunTree: typeof import("../src/privacy.js").createRunTree;
let createSecretAnonymizer: typeof import("langsmith/anonymizer").createSecretAnonymizer;
let clients: Set<SDKClient>;
let requests: RequestBody[];
let transport: Transport;
let allowedOrigins: string[];

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
  usage_metadata: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
  ls_subagent_id: "subagent",
  ls_subagent_type: "Explore",
};

async function decodeMultipart(raw: string, contentType: string): Promise<Operation[]> {
  const form = await new Response(raw, { headers: { "content-type": contentType } }).formData();
  const operations = new Map<string, Operation>();
  for (const [name, part] of form.entries()) {
    const match = /^(post|patch)\.([^.]+)(?:\.(.+))?$/.exec(name);
    // Unexpected attachment/other parts must fail rather than go unexamined.
    expect(match, `unexpected multipart part ${name}`).not.toBeNull();
    const [, action, id, field] = match!;
    const key = `${action}.${id}`;
    const op = operations.get(key) ?? { action: action as Operation["action"], payload: {} };
    const value = JSON.parse(typeof part === "string" ? part : await part.text());
    if (field) op.payload[field] = value;
    else Object.assign(op.payload, value);
    operations.set(key, op);
  }
  return [...operations.values()];
}

const captureFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  // Even shared/fallback clients cannot make an external request.
  expect(allowedOrigins).toContain(url.origin);
  if (url.pathname === "/info") {
    return Response.json({
      batch_ingest_config: { use_multipart_endpoint: transport === "multipart" },
    });
  }
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
  let operations: Operation[];
  if (url.pathname.endsWith("/runs/multipart")) {
    operations = await decodeMultipart(raw, headers.get("content-type")!);
  } else if (url.pathname.endsWith("/runs/batch")) {
    const body = JSON.parse(raw);
    operations = [
      ...(body.post ?? []).map((payload: Payload) => ({ action: "post" as const, payload })),
      ...(body.patch ?? []).map((payload: Payload) => ({ action: "patch" as const, payload })),
    ];
  } else {
    expect(method).toMatch(/^(POST|PATCH)$/);
    expect(url.pathname).toMatch(/\/runs(?:\/[\da-f-]+)?$/);
    operations = [{ action: method === "POST" ? "post" : "patch", payload: JSON.parse(raw) }];
  }
  requests.push({ url, method, raw, operations, headers });
  return Response.json({});
};

beforeEach(async () => {
  // getRuntimeEnvironment/getShas and Client metadata are cached by the SDK.
  // Install markers BEFORE importing/constructing any real SDK objects, and
  // isolate its shared client/cache from other cases (and ambient tracing env).
  vi.resetModules();
  for (const key of Object.keys(process.env)) {
    if (/^(LANGCHAIN_|LANGSMITH_|CC_LANGSMITH_)/.test(key)) vi.stubEnv(key, undefined);
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
  clients = new Set();
  requests = [];
  transport = "non-batched";
  allowedOrigins = [API];
  ({ Client, RunTree } = await import("langsmith"));
  ({ createRunTree } = await import("../src/privacy.js"));
  ({ createSecretAnonymizer } = await import("langsmith/anonymizer"));
});

afterEach(async () => {
  try {
    await Promise.all([...clients].map((client) => client.flush()));
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

function makeClient(): SDKClient {
  const batched = transport !== "non-batched";
  const client = new Client({
    apiUrl: API,
    apiKey: "test-only-key",
    autoBatchTracing: batched,
    manualFlushMode: batched,
    blockOnRootRunFinalization: false,
    tracingSamplingRate: 1,
    // Deliberately leave omitTracedRuntimeInfo at its SDK default (false).
    anonymizer: createSecretAnonymizer({ extraRules: [{ pattern: SECRET, replace: REDACTED }] }),
    hideMetadata: createSecretAnonymizer({ extraRules: [{ pattern: SECRET, replace: REDACTED }] }),
    fetchImplementation: captureFetch,
  });
  clients.add(client);
  return client;
}

function config(
  client?: SDKClient,
  status: Status = "running",
  id: string = randomUUID(),
): RunTreeConfig {
  return {
    client,
    id,
    trace_id: id,
    dotted_order: `20250101T000000000000Z${id}`,
    name: "privacy integration",
    run_type: "chain",
    project_name: "primary",
    start_time: "2025-01-01T00:00:00Z",
    ...(status !== "running" ? { end_time: "2025-01-01T00:00:01Z" } : {}),
    ...(status === "error" ? { error: `${FORBIDDEN}_raw_error` } : {}),
    inputs: { prompt: `${FORBIDDEN}_input` },
    outputs: { answer: `${FORBIDDEN}_output` },
    tags: [`${FORBIDDEN}_tag`],
    serialized: { private: `${FORBIDDEN}_serialized` },
    extra: {
      private: `${FORBIDDEN}_extra`,
      runtime: { custom: `${FORBIDDEN}_runtime` },
      metadata: {
        ...allowedMetadata,
        cwd: `${FORBIDDEN}_cwd`,
        repository_name: `${FORBIDDEN}_repository`,
        user_id: `${FORBIDDEN}_identity`,
        ls_invocation_params: { private: FORBIDDEN },
        custom: FORBIDDEN,
      },
    },
  };
}

async function flush(): Promise<void> {
  await Promise.all([...clients].map((client) => client.flush()));
}

function expectTransport(expectedRequests: number): Operation[] {
  expect(requests).toHaveLength(expectedRequests);
  for (const request of requests) {
    if (transport === "non-batched") {
      expect(request.url.pathname).toMatch(/\/runs(?:\/[\da-f-]+)?$/);
      expect(request.operations).toHaveLength(1);
    } else {
      expect(request.method).toBe("POST");
      expect(
        request.url.pathname.endsWith(
          transport === "multipart" ? "/runs/multipart" : "/runs/batch",
        ),
      ).toBe(true);
    }
  }
  return requests.flatMap((request) => request.operations);
}

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
  expect.soft(payload.outputs).toEqual({
    messages: [
      {
        role: "assistant",
        content: "[LangSmith system notice: content omitted because tracing is muted.]",
      },
    ],
  });
}

function expectMetadata(payload: Payload, status: Status, redacted = true): void {
  // Soft assertions show post AND patch leaks in one run, rather than hiding
  // replica update failures behind the earlier post's runtime enrichment.
  expectMutedContent(payload);
  expect.soft(payload.error).toBeUndefined();
  // Exact equality, not just a denylist: newly SDK-injected keys are forbidden too.
  expect.soft(payload.extra).toEqual({
    metadata: {
      ...allowedMetadata,
      ls_model_name: redacted ? REDACTED : SECRET,
      status,
      ls_tracing_mode: "metadata",
    },
  });
  expect.soft(JSON.stringify(payload)).not.toContain(FORBIDDEN);
  if (redacted) expect.soft(JSON.stringify(payload)).not.toContain(SECRET);
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

describe.each(transports)("real SDK privacy over %s", (selectedTransport) => {
  it.each(["base"] as const)(
    "projects custom %s collisions using explicit builder provenance at the wire",
    async () => {
      transport = selectedTransport;
      const { codingAgentMetadata } = await import("../src/metadata.js");
      const collisions = Object.fromEntries(
        Object.keys(allowedMetadata).map((key) => [key, `${FORBIDDEN}_${key}`]),
      );
      collisions.usage_metadata = { total_tokens: 999, custom: FORBIDDEN };
      const metadata = codingAgentMetadata({
        threadId: "plugin-session",
        turnId: "plugin-turn",
        turnNumber: 2,
        agentType: "root",
        runtimeVersion: "plugin-runtime",
        base: collisions,
        runSpecific: {
          ls_model_name: SECRET,
          usage_metadata: {
            input_tokens: 7,
            output_tokens: 3,
            total_tokens: 10,
            input_token_details: { cache_read: 4, cache_creation: 1, custom: FORBIDDEN },
          },
        },
      });
      const client = makeClient();
      const initial = { ...config(client), extra: { metadata } };
      await createRunTree(initial, "metadata").postRun();
      await flush();
      await createRunTree(
        { ...config(client, "completed", initial.id), extra: { metadata } },
        "metadata",
      ).patchRun({ excludeInputs: true });
      await flush();
      const operations = expectTransport(2);
      expect(operations.map(({ action }) => action)).toEqual(["post", "patch"]);
      for (const { action, payload } of operations) {
        expectMutedContent(payload, action === "patch");
        expect(payload.extra).toEqual({
          metadata: {
            thread_id: "plugin-session",
            turn_id: "plugin-turn",
            turn_number: 2,
            ls_agent_purpose: "coding",
            ls_agent_type: "root",
            ls_agent_runtime: "Cursor",
            ls_agent_runtime_version: "plugin-runtime",
            ls_integration: "cursor",
            ls_integration_version: "plugin-version",
            ls_trace_schema_version: "coding-agent-v1",
            ls_model_name: REDACTED,
            usage_metadata: {
              input_tokens: 7,
              output_tokens: 3,
              total_tokens: 10,
              input_token_details: { cache_read: 4, cache_creation: 1 },
            },
            status: action === "post" ? "running" : "completed",
            ls_tracing_mode: "metadata",
          },
        });
        expect(JSON.stringify(payload)).not.toContain(FORBIDDEN);
        expect(JSON.stringify(payload)).not.toContain(SECRET);
      }
    },
  );

  it("preserves parent identity, trace ordering and lifecycle timestamps on the wire", async () => {
    transport = selectedTransport;
    const client = makeClient();
    const parentId = randomUUID();
    const traceId = randomUUID();
    const initial = {
      ...config(client),
      parent_run_id: parentId,
      trace_id: traceId,
      dotted_order: `20241231T235959000000Z${parentId}.20250101T000000000000Z${randomUUID()}`,
    };
    await createRunTree(initial, "metadata").postRun();
    await flush();
    await createRunTree(
      { ...initial, end_time: "2025-01-01T00:00:01Z", error: `${FORBIDDEN}_failure` },
      "metadata",
    ).patchRun();
    await flush();
    const operations = expectTransport(2);
    expect(operations.map(({ action }) => action)).toEqual(["post", "patch"]);
    expect(operations[0].payload).toMatchObject({
      id: initial.id,
      name: initial.name,
      run_type: initial.run_type,
      session_name: initial.project_name,
      start_time: initial.start_time,
    });
    expect(operations[0].payload.end_time).toBeUndefined();
    for (const { payload } of operations) {
      expect(payload).toMatchObject({
        parent_run_id: parentId,
        trace_id: traceId,
        dotted_order: initial.dotted_order,
      });
    }
    expect(operations[1].payload.end_time).toBe("2025-01-01T00:00:01Z");
    expectMetadata(operations[0].payload, "running");
    expectMetadata(operations[1].payload, "error");
  });

  it("mixes metadata and full runs on one client, with separately serialized post and patch", async () => {
    transport = selectedTransport;
    const client = makeClient();
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const modes = ["metadata", "full", "metadata"] as const;
    for (let i = 0; i < ids.length; i++) {
      const run = createRunTree(config(client, "running", ids[i]), modes[i]);
      expect(run).toBeInstanceOf(RunTree);
      await run.postRun();
    }
    // A real flush boundary prevents the SDK merging a patch into its post.
    await flush();
    expectTransport(transport === "non-batched" ? 3 : 1);
    for (let i = 0; i < ids.length; i++) {
      // The plugin reconstructs RunTrees for updates in later hook processes.
      await createRunTree(
        config(client, i === 2 ? "completed" : "error", ids[i]),
        modes[i],
      ).patchRun();
    }
    await flush();
    const operations = expectTransport(transport === "non-batched" ? 6 : 2);
    expect(operations).toHaveLength(6);
    for (let i = 0; i < ids.length; i++) {
      const own = operations.filter(
        ({ payload }) =>
          payload.id === ids[i] ||
          // Non-batched PATCH identifies the run in its URL, not its JSON body.
          requests.some(
            (request) =>
              request.url.pathname.endsWith(`/runs/${ids[i]}`) &&
              request.operations.some((op) => op.payload === payload),
          ),
      );
      expect(own.map(({ action }) => action)).toEqual(["post", "patch"]);
      if (modes[i] === "metadata") {
        expectMetadata(own[0].payload, "running");
        expectMetadata(own[1].payload, i === 2 ? "completed" : "error");
      } else {
        for (const { payload } of own) {
          expect(payload.inputs).toEqual({ prompt: `${FORBIDDEN}_input` });
          expect(payload.outputs).toEqual({ answer: `${FORBIDDEN}_output` });
          expect(payload.extra.metadata).toMatchObject({
            custom: FORBIDDEN,
            ls_model_name: REDACTED,
          });
          expect(payload.extra.metadata.ls_tracing_mode).toBeUndefined();
        }
        expect(own[0].payload.extra.metadata).toMatchObject({
          revision_id: REVISION,
          LANGSMITH_WORKSPACE_ID: WORKSPACE,
        });
        expect(own[0].payload.extra.runtime).toMatchObject({
          library: "langsmith",
          CI_COMMIT_SHA: CI_SHA,
        });
        expect(own[1].payload.error).toBe(`${FORBIDDEN}_raw_error`);
      }
    }
  });

  it.each(["object", "tuple"] as const)(
    "sanitizes %s replica updates without bypassing the destination anonymizer",
    async (kind) => {
      transport = selectedTransport;
      const primary = makeClient();
      const dedicated = makeClient();
      const replicas: RunTreeConfig["replicas"] =
        kind === "object"
          ? [
              {
                projectName: "replica",
                apiUrl: `${API}/dedicated`,
                client: dedicated,
                updates: replicaUpdates(),
              },
            ]
          : [["replica", replicaUpdates()]];
      const initial = { ...config(primary), replicas };
      await createRunTree(initial, "metadata").postRun();
      await flush();
      expectTransport(1);
      await createRunTree(
        { ...config(primary, "error", initial.id), replicas },
        "metadata",
      ).patchRun();
      await flush();
      const operations = expectTransport(2);
      expect(operations.map(({ action }) => action)).toEqual(["post", "patch"]);
      expect(operations[0].payload.session_name).toBe("replica");
      expect(
        requests.every(({ url }) =>
          url.pathname.startsWith(kind === "object" ? "/dedicated/runs" : "/runs"),
        ),
      ).toBe(true);
      expectMetadata(operations[0].payload, "running");
      expectMetadata(operations[1].payload, "error");
    },
  );
});

describe.each(["json-batch", "multipart"] as const)(
  "coalesced %s payloads",
  (selectedTransport) => {
    it("retains the final privacy projection when a patch merges into its create", async () => {
      transport = selectedTransport;
      const client = makeClient();
      const initial = config(client);
      await createRunTree(initial, "metadata").postRun();
      await createRunTree(config(client, "completed", initial.id), "metadata").patchRun();
      await flush();
      const operations = expectTransport(1);
      expect(operations).toHaveLength(1);
      expect(operations[0].action).toBe("post");
      expectMetadata(operations[0].payload, "completed");
      expect(requests[0].raw).not.toContain(FORBIDDEN);
    });
  },
);

describe("environment and shared SDK clients", () => {
  it("filters metadata/runtime on a real shared-client fallback", async () => {
    // No getSharedClient mock/private singleton replacement. The default shared
    // client batches; its global fetch is intercepted just like explicit clients.
    transport = "json-batch";
    const initial = {
      ...config(),
      replicas: [["shared-replica", replicaUpdates()]] as RunTreeConfig["replicas"],
    };
    const run = createRunTree(initial, "metadata");
    const shared = RunTree.getSharedClient();
    clients.add(shared);
    expect(run.client).toBe(shared);
    await run.postRun();
    await flush();
    expectTransport(1);
    await createRunTree(
      { ...initial, ...config(undefined, "completed", initial.id) },
      "metadata",
    ).patchRun();
    await flush();
    const operations = expectTransport(2);
    expect(operations.map(({ action }) => action)).toEqual(["post", "patch"]);
    // Shared SDK client has no anonymizer configured; privacy still applies.
    expectMetadata(operations[0].payload, "running", false);
    expectMetadata(operations[1].payload, "completed", false);
  });

  it.each(["plugin", "sdk"] as const)(
    "does not leak %s environment-derived replica updates",
    async (source) => {
      transport = "json-batch";
      const updates = replicaUpdates();
      if (source === "plugin") {
        vi.stubEnv("LANGSMITH_CURSOR_RUNS_ENDPOINTS", JSON.stringify([["env-replica", updates]]));
      } else {
        // SDK endpoint parsing ignores updates, but the entire environment string
        // is also injected as metadata by Client, including on batched PATCH.
        vi.stubEnv(
          "LANGSMITH_RUNS_ENDPOINTS",
          JSON.stringify([
            {
              api_url: `${API}/environment`,
              api_key: "test-only-key",
              project_name: "env-replica",
              updates,
            },
          ]),
        );
      }
      const client = makeClient();
      // Same JSON parsing as loadConfig, without unrelated disk/git discovery.
      const replicas =
        source === "plugin" ? JSON.parse(process.env.LANGSMITH_CURSOR_RUNS_ENDPOINTS!) : undefined;
      const initial = { ...config(client), replicas };
      await createRunTree(initial, "metadata").postRun();
      await flush();
      expectTransport(1);
      await createRunTree(
        { ...config(client, "error", initial.id), replicas },
        "metadata",
      ).patchRun();
      await flush();
      const operations = expectTransport(2);
      expect(operations.map(({ action }) => action)).toEqual(["post", "patch"]);
      expect(operations[0].payload.session_name).toBe("env-replica");
      expectMetadata(operations[0].payload, "running");
      expectMetadata(operations[1].payload, "error");
      for (const request of requests) expect(request.raw).not.toContain(FORBIDDEN);
    },
  );
});

describe.each(transports)("Cursor child boundary over %s", (selectedTransport) => {
  it("drops inherited distributed content and late mutations while retaining parentage", async () => {
    transport = selectedTransport;
    const client = makeClient();
    const parent = RunTree.fromHeaders(
      {
        "langsmith-trace": `20250101T000000000000Z${randomUUID()}`,
        baggage: `langsmith-metadata=${encodeURIComponent(JSON.stringify({ thread_id: FORBIDDEN, cwd: FORBIDDEN }))},langsmith-tags=${FORBIDDEN}`,
      },
      { client },
    )!;
    parent.events = [{ name: FORBIDDEN, time: new Date().toISOString() }];
    parent.attachments = { private: ["text/plain", Buffer.from(FORBIDDEN)] };
    const root = createRunTree({ ...config(client), parent_run: parent }, "metadata");
    await root.postRun();
    const child = root.createChild({
      ...config(client, "error"),
      trace_id: undefined,
      dotted_order: undefined,
      name: "Read",
      run_type: "tool",
    });
    child.inputs = { private: FORBIDDEN };
    child.outputs = { private: FORBIDDEN };
    child.tags = [FORBIDDEN];
    child.events = parent.events;
    child.attachments = parent.attachments;
    child.extra = {
      metadata: { ...allowedMetadata, thread_id: FORBIDDEN },
      runtime: { private: FORBIDDEN },
    };
    await child.postRun();
    await flush();
    root.outputs = { private: FORBIDDEN };
    root.error = FORBIDDEN;
    root.end_time = Date.parse("2025-01-01T00:00:02Z");
    await root.patchRun();
    await flush();
    const operations = requests.flatMap((r) => r.operations);
    expect(operations).toHaveLength(3);
    expectMetadata(operations[0].payload, "running");
    expectMetadata(operations[1].payload, "error");
    expectMetadata(operations[2].payload, "error");
    expect(operations[0].payload.parent_run_id).toBe(parent.id);
    expect(operations[1].payload.parent_run_id).toBe(root.id);
    expect(operations[1].payload.trace_id).toBe(root.trace_id);
    for (const request of requests) expect(request.raw).not.toContain(FORBIDDEN);
  });
});

describe.each(transports)("overlapping Cursor launch privacy over %s", (selectedTransport) => {
  it.each([
    "conversation-id",
    "muted-generation",
    "full-generation",
    "full-tool-link",
    "conflicting-proof",
  ] as const)("uses %s evidence without changing the latest-turn tree", async (evidence) => {
    transport = selectedTransport;
    const {
      reduceBeforeSubmitPrompt,
      reducePostToolUse,
      reduceSubagentStart,
      reduceSubagentStop,
      reduceStop,
    } = await import("../src/reducer.js");
    const { initTracing, buildTurnRuns } = await import("../src/langsmith.js");
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
    const client = makeClient();
    initTracing(undefined, undefined, undefined, false, undefined, client);
    const shapes = [];
    // Compare privacy-only rendering to the old full serialization, not a different join.
    for (const baseline of [false, true]) {
      requests = [];
      await buildTurnRuns({
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
      });
      await flush();
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
  describe.each(transports)("at the wire over %s", (selectedTransport) => {
    it.each([
      "muted-redact-off",
      "full-redact-off",
      "full-file-rules",
      "keyless-muted-redact-off",
      "keyless-full-redact-off",
    ] as const)("%s", async (scenario) => {
      transport = selectedTransport;
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
        const { loadState } = await import("../src/state.js");
        const { reduceStop } = await import("../src/reducer.js");
        const { initTracing, buildTurnRuns } = await import("../src/langsmith.js");
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
        const client = initTracing(
          cfg.apiKey,
          cfg.apiUrl,
          cfg.replicas,
          cfg.redact,
          cfg.redactExtraRules,
        )!;
        // Transport selection only; routing/auth/redaction remain the production config path.
        Object.assign(client, {
          autoBatchTracing: transport !== "non-batched",
          manualFlushMode: transport !== "non-batched",
          blockOnRootRunFinalization: false,
        });
        clients.add(client);
        await buildTurnRuns({
          buffer: { ...stopped.buffer!, finalText: "file-sensitive-789" },
          conversationId: input.conversation_id,
          turnNum: stopped.turnNum,
          project: cfg.project,
          customMetadata: cfg.customMetadata,
        });
        await flush();
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
