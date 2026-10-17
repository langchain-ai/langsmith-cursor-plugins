import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hook = vi.hoisted(() => ({
  inputs: [] as Array<Record<string, unknown>>,
  script: "",
  steps: undefined as unknown,
}));

vi.mock("../src/conversation-steps.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveTurnSteps: () => hook.steps,
}));

vi.mock("../src/utils/stdin.js", () => ({ readStdin: async () => hook.inputs.shift() }));
vi.mock("@langchain/plugins-base/plugin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@langchain/plugins-base/plugin")>();
  return {
    ...actual,
    launchDetachedWorker: (args: readonly string[], options: { storageRoot?: string } = {}) =>
      actual.launchDetachedWorker(args, { ...options, executable: hook.script }),
  };
});

import { handlePromptSubmit } from "../src/prompt-control.js";
import { atomicUpdateState } from "../src/state.js";
import { reducePostToolUse } from "../src/reducer.js";
import { run as postToolUse } from "../src/hooks/post-tool-use.js";
import { run as postToolUseFailure } from "../src/hooks/post-tool-use-failure.js";
import { run as afterAgentResponse } from "../src/hooks/after-agent-response.js";
import { run as stop } from "../src/hooks/stop.js";
import { runSweep } from "../src/sweep.js";
import { loadConfig } from "../src/config.js";
import { saveToolForUpload } from "../src/tracing-engine.js";
import type { TurnBuffer } from "../src/models/types.js";
import { HOUR, loadState } from "./utils/state.js";
import { until, waitForWorkers, writeWorkerScript } from "./utils/engine.js";

const BASE = { conversation_id: "live-conv", generation_id: "live-gen", model: "default" };

let dir: string;
let server: Server;
const DUPLICATE_UPDATE =
  "Run update payload already received. Duplicate run update requests for the same run are not supported.";

let ops: Array<{ action: string; run: Record<string, unknown>; key: unknown }>;
let refused: Array<{ status: number; ids: unknown[] }>;
let updated: Set<unknown>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ls-cursor-live-"));
  hook.script = writeWorkerScript(dir);
  ops = [];
  refused = [];
  updated = new Set();
  hook.steps = undefined;
  server = createServer((request, response) => {
    const body: Buffer[] = [];
    request.on("data", (chunk: Buffer) => body.push(chunk));
    request.on("end", () => {
      let batch: Record<string, Array<Record<string, unknown>>> = {};
      try {
        batch = JSON.parse(Buffer.concat(body).toString("utf8"));
      } catch {}
      const patches = batch.patch ?? [];
      const missing = patches.findIndex((run) => !run.end_time);
      const fresh = patches.filter((run, i) => {
        const repeat = updated.has(run.id) || patches.slice(0, i).some((r) => r.id === run.id);
        return !repeat;
      });
      const posts = batch.post ?? [];
      const [status, error] =
        missing >= 0
          ? [
              422,
              `Unprocessable entity: invalid batch JSON: batch schema error patch.${missing}: end_time is required`,
            ]
          : posts.length === 0 && patches.length > 0 && fresh.length === 0
            ? [409, DUPLICATE_UPDATE]
            : [202, ""];
      if (status === 202) {
        for (const run of fresh) updated.add(run.id);
        for (const [action, runs] of [
          ["post", posts],
          ["patch", fresh],
        ] as const) {
          for (const run of runs) ops.push({ action, run, key: request.headers["x-api-key"] });
        }
      }
      if (status !== 202 || fresh.length < patches.length) {
        refused.push({ status, ids: patches.map((run) => run.id) });
      }
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(status === 202 ? {} : { error }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  vi.stubEnv("TRACE_TO_LANGSMITH", "1");
  vi.stubEnv("LANGSMITH_CURSOR_API_KEY", "synthetic-key");
  vi.stubEnv("LANGSMITH_CURSOR_ENDPOINT", `http://127.0.0.1:${port}`);
  vi.stubEnv("LANGSMITH_CURSOR_STATE_FILE", join(dir, "state.json"));
  vi.stubEnv("LANGSMITH_CURSOR_LOG_FILE", join(dir, "hook.log"));
  vi.stubEnv("LANGSMITH_CURSOR_PRIVACY_FILE", join(dir, "privacy.json"));
  vi.stubEnv("LANGSMITH_CURSOR_DB_PATH", join(dir, "absent.vscdb"));
  vi.stubEnv("LANGSMITH_CURSOR_ATTACHMENTS", "false");
  vi.stubEnv("LANGSMITH_CURSOR_SYSTEM_PROMPT", "false");
});

afterEach(async () => {
  await waitForWorkers(dir);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
});

function toolInput(id: string, name: string, failed = false): Record<string, unknown> {
  return {
    ...BASE,
    workspace_roots: [dir],
    hook_event_name: failed ? "postToolUseFailure" : "postToolUse",
    tool_name: name,
    tool_use_id: id,
    tool_input: { id },
    ...(failed ? { error_message: "boom", failure_type: "error" } : { tool_output: '"ok"' }),
  };
}

function runHook(run: () => Promise<unknown>, input: Record<string, unknown>): Promise<unknown> {
  hook.inputs.push(input);
  return run();
}

const posted = (name: string) => ops.filter((op) => op.action === "post" && op.run.name === name);
const postedIds = () => ops.filter((op) => op.action === "post").map((op) => op.run.id);
const finalOf = (id: unknown) =>
  Object.assign({}, ...ops.filter((op) => op.run.id === id).map((op) => op.run));

const promptHook = () =>
  handlePromptSubmit({
    ...BASE,
    workspace_roots: [dir],
    hook_event_name: "beforeSubmitPrompt",
    prompt: "run tools",
  });
const turnEnd = async (status = "completed") => {
  await runHook(afterAgentResponse, {
    ...BASE,
    workspace_roots: [dir],
    hook_event_name: "afterAgentResponse",
    text: "done",
  });
  await runHook(stop, { ...BASE, workspace_roots: [dir], hook_event_name: "stop", status });
};
const rootId = () => posted("Cursor Turn 1")[0]?.run.id;
const turnClosed = () =>
  rootId() !== undefined &&
  finalOf(rootId()).outputs !== undefined &&
  postedIds().every((id) => finalOf(id).end_time);

describe("a tool run saved as soon as its tool finishes", { timeout: 120_000 }, () => {
  it("reaches LangSmith before stop, and stop fills in the rest with every run sent once", async () => {
    await promptHook();
    await runHook(postToolUse, toolInput("t-shell", "Shell"));
    await runHook(postToolUse, toolInput("t-read", "Read"));
    await runHook(postToolUseFailure, toolInput("t-write", "Write", true));
    await atomicUpdateState(join(dir, "state.json"), (s) =>
      reducePostToolUse(s, toolInput("t-unsaved", "Grep") as never, Date.now()),
    );

    expect(await until(() => ["Shell", "Read", "Write"].every((n) => posted(n).length))).toBe(true);
    expect(posted("Write")[0].run.error).toBe("boom");
    expect(posted("Grep")).toEqual([]);
    expect(posted("Cursor Turn 1")).toHaveLength(1);
    const config = loadConfig({ cwd: dir });
    const buffer = loadState(join(dir, "state.json"))["live-conv"].turns["live-gen"];
    const options = { buffer, conversationId: "live-conv", turnNum: 1, project: config.project };
    await saveToolForUpload(config, options, 0, () => []);

    hook.steps = [
      { kind: "tool", toolUseId: "t-shell" },
      { kind: "assistant", text: "next" },
      { kind: "tool", toolUseId: "t-write" },
      { kind: "tool", toolUseId: "t-unsaved" },
      { kind: "assistant", text: "done" },
    ];
    await turnEnd("error");

    expect(await until(() => posted("Grep").length > 0 && turnClosed())).toBe(true);
    expect(refused.filter(({ status }) => status === 422)).toEqual([]);
    for (const name of ["Cursor Turn 1", "Shell", "Read", "Write", "Grep"]) {
      expect(posted(name)).toHaveLength(1);
    }
    expect(finalOf(rootId())).toMatchObject({ outputs: { text: "done" }, error: "error" });
  });

  it("keeps the turn on the API key that saved its first run", async () => {
    await promptHook();
    await runHook(postToolUse, toolInput("t-shell", "Shell"));
    expect(await until(() => posted("Shell").length > 0)).toBe(true);
    vi.stubEnv("LANGSMITH_CURSOR_API_KEY", "synthetic-key-b");
    await turnEnd();
    expect(loadState(join(dir, "state.json"))["live-conv"].pending).toBeDefined();

    vi.stubEnv("LANGSMITH_CURSOR_API_KEY", "synthetic-key");
    await runSweep({
      config: loadConfig({ cwd: dir }),
      conversationId: "later-conv",
      nowMs: Date.now() + 7 * HOUR,
    });
    expect(await until(turnClosed)).toBe(true);
    expect(ops.filter(({ key }) => key !== "synthetic-key")).toEqual([]);
  });

  it("saves nothing when a tool's save runs after stop closed its turn", async () => {
    await promptHook();
    let buffer: TurnBuffer | undefined;
    await atomicUpdateState(join(dir, "state.json"), (s) => {
      const next = reducePostToolUse(s, toolInput("t-shell", "Shell") as never, Date.now());
      buffer = structuredClone(next["live-conv"].turns["live-gen"]);
      return next;
    });
    await turnEnd();
    expect(await until(turnClosed)).toBe(true);
    const sent = ops.length;
    const config = loadConfig({ cwd: dir });
    const options = {
      buffer: buffer!,
      conversationId: "live-conv",
      turnNum: 1,
      project: config.project,
    };
    await saveToolForUpload(config, options, 0, () => []);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(ops.length).toBe(sent);
  });
});
