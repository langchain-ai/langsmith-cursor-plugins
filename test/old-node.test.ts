import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportOldNode } from "../src/hooks/report-old-node.js";
import { DEFAULT_TAGS } from "../src/constants.js";

type Run = Record<string, any>;

const REPORT = {
  message: "[langsmith] Node 20.20.2 at /opt/node/bin/node is too old for tracing",
  version: "20.20.2",
  execPath: "/opt/node/bin/node",
};

let server: Server;
let endpoint: string;
let home: string;
let posted: Run[];
let bodies: string[];
let requests: number;
let stall: boolean;

// Capture at the HTTP boundary rather than mocking the SDK, so batching and
// transport selection are exercised the way a real upload hits ingest. Ingest
// sends each run as a base part plus `post.<id>.<field>` parts.
async function collect(request: IncomingMessage, raw: string): Promise<void> {
  bodies.push(raw);
  const contentType = request.headers["content-type"] ?? "";
  const form = await new Response(raw, { headers: { "content-type": contentType } }).formData();
  const runs = new Map<string, Run>();
  for (const [name, part] of form.entries()) {
    const [, id, field] = name.split(".");
    const run = runs.get(id) ?? {};
    const value = JSON.parse(typeof part === "string" ? part : await part.text());
    if (field) run[field] = value;
    else Object.assign(run, value);
    runs.set(id, run);
  }
  posted.push(...runs.values());
}

beforeEach(async () => {
  posted = [];
  bodies = [];
  requests = 0;
  stall = false;
  home = mkdtempSync(join(tmpdir(), "langsmith-old-node-home-"));
  // Cursor owns ~/.cursor; the guard appends to its log rather than creating it.
  mkdirSync(join(home, ".cursor"));
  server = createServer((request, response) => {
    let raw = "";
    requests += 1;
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      if (stall) return; // Accept the request, never answer it.
      const done = request.url?.includes("/runs") ? collect(request, raw) : Promise.resolve();
      void done.finally(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  endpoint = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  for (const key of Object.keys(process.env)) {
    if (/^(LANGSMITH_|LANGCHAIN_|CURSOR_PROJECT_DIR|TRACE_TO_LANGSMITH)/.test(key)) {
      vi.stubEnv(key, undefined as unknown as string);
    }
  }
  vi.stubEnv("HOME", home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  // A stalled request holds its socket open, and close() waits for it.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** The env the reporter reads in-process, and the guard's child reads from its own env. */
function tracingEnv(): Record<string, string> {
  return {
    TRACE_TO_LANGSMITH: "1",
    LANGSMITH_CURSOR_API_KEY: "lsv2_test_key",
    LANGSMITH_CURSOR_ENDPOINT: endpoint,
    LANGSMITH_CURSOR_PROJECT: "lsdk-360-test",
    CURSOR_PROJECT_DIR: home,
  };
}

function enableTracing(): void {
  for (const [key, value] of Object.entries(tracingEnv())) vi.stubEnv(key, value);
}

describe("reportOldNode", () => {
  it("posts one error run naming the node that could not run the hooks", async () => {
    enableTracing();
    await reportOldNode(REPORT);

    expect(posted).toHaveLength(1);
    const run = posted[0];
    expect(run.name).toBe("Cursor Tracing Unavailable");
    expect(run.run_type).toBe("chain");
    expect(run.session_name).toBe("lsdk-360-test");
    expect(run.error).toBe(REPORT.message);
    expect(run.tags).toEqual(DEFAULT_TAGS);
    // A zero-length closed run, so it never shows as still running.
    expect(run.end_time).toBe(Date.parse(run.start_time));
    expect(run.extra.metadata).toMatchObject({
      ls_agent_purpose: "coding",
      ls_agent_type: "root",
      ls_integration: "cursor",
      ls_agent_runtime: "Cursor",
      ls_trace_schema_version: "coding-agent-v1",
      node_version: "20.20.2",
      node_exec_path: "/opt/node/bin/node",
    });
  });

  it("carries no workspace or conversation content", async () => {
    enableTracing();
    await reportOldNode(REPORT);

    // These reach the wire if config.customMetadata is ever attached here.
    expect(bodies.join("")).not.toContain(userInfo().username);
    expect(bodies.join("")).not.toContain(process.cwd());
    expect(posted[0].outputs).toBeUndefined();
    expect(posted[0].attachments).toBeUndefined();
  });

  it("uploads nothing when tracing is disabled or no credentials are set", async () => {
    enableTracing();
    vi.stubEnv("TRACE_TO_LANGSMITH", "false");
    await reportOldNode(REPORT);
    expect(posted).toEqual([]);

    vi.stubEnv("TRACE_TO_LANGSMITH", "true");
    vi.stubEnv("LANGSMITH_CURSOR_API_KEY", undefined as unknown as string);
    await reportOldNode(REPORT);
    expect(posted).toEqual([]);
    expect(requests).toBe(0);
  });

  it("gives up on an endpoint that never answers", async () => {
    enableTracing();
    stall = true;
    const started = Date.now();
    await reportOldNode(REPORT, 300);
    const elapsed = Date.now() - started;

    // The budget ended the wait, not a missing request and not the SDK.
    expect(requests).toBeGreaterThan(0);
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(3_000);
    expect(posted).toEqual([]);
  });
});

// Point CURSOR_PLUGIN_TEST_OLD_NODE at a Node older than MIN_NODE to run this.
// CI sets it; locally, use something like `$(mise where node@20.20.2)/bin/node`.
const oldNode = process.env.CURSOR_PLUGIN_TEST_OLD_NODE;

const HOOKS = [
  "before-submit-prompt",
  "after-agent-response",
  "post-tool-use",
  "post-tool-use-failure",
  "subagent-start",
  "subagent-stop",
  "stop",
  "session-start",
];

interface GuardResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Must not block the event loop: the guard uploads to the server started above.
function runGuard(hook: string): Promise<GuardResult> {
  return new Promise((resolve, reject) => {
    const guard = new URL("../bundle/guard.js", import.meta.url).pathname;
    const child = spawn(oldNode!, [guard, hook], {
      env: {
        PATH: process.env.PATH!,
        HOME: home,
        // Without this the guard hands off to the login shell's Node, which on
        // a developer machine is new enough to take the success path instead.
        LANGSMITH_CURSOR_NODE_HANDOFF: "1",
        ...tracingEnv(),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify({ conversation_id: "c1", generation_id: "g1" }));
  });
}

it.skipIf(!oldNode)("reports once per turn, not once per hook", { timeout: 120_000 }, async () => {
  const results: GuardResult[] = [];
  for (const hook of HOOKS) results.push(await runGuard(hook));

  expect(
    results.map((r) => r.status),
    results[0].stderr,
  ).toEqual(HOOKS.map(() => 0));
  expect(posted).toHaveLength(1);
  expect(posted[0].name).toBe("Cursor Tracing Unavailable");
  expect(posted[0].error).toContain("is too old for tracing");

  // Every hook still logs locally, and only the prompt hook blocks.
  const log = readFileSync(join(home, ".cursor", "langsmith-hook.log"), "utf8");
  expect(log.trim().split("\n")).toHaveLength(HOOKS.length);
  expect(JSON.parse(results[0].stdout)).toMatchObject({ continue: false });
  expect(results.slice(1).map((r) => r.stdout)).toEqual(HOOKS.slice(1).map(() => ""));
});

it.runIf(process.env.CI)("CI supplies an old node to test the guard against", () => {
  expect(oldNode).toBeTruthy();
});
