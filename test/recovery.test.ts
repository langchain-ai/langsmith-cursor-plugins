import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const worker = vi.hoisted(() => ({ script: "", start: true, launches: [] as string[][] }));

vi.mock("@langchain/plugins-base/plugin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@langchain/plugins-base/plugin")>();
  return {
    ...actual,
    launchDetachedWorker: (args: readonly string[], options: { storageRoot?: string } = {}) => {
      worker.launches.push([...args]);
      if (!worker.start) return Promise.reject(new Error("worker launch is mocked"));
      return actual.launchDetachedWorker(args, { ...options, executable: worker.script });
    },
  };
});

import { recoverConversations, saveTurnForUpload } from "../src/tracing-engine.js";
import { HOUR, T0, testConfig, turn } from "./utils/state.js";
import { until, waitForWorkers, writeWorkerScript } from "./utils/engine.js";

const THREE_HOURS_AGO = new Date(Date.now() - 3 * HOUR);

let dir: string;
let server: Server;
let uploaded: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ls-cursor-recovery-"));
  worker.start = true;
  worker.launches.length = 0;
  worker.script = writeWorkerScript(dir);
  uploaded = [];
  server = createServer((request, response) => {
    const body: Buffer[] = [];
    request.on("data", (chunk: Buffer) => body.push(chunk));
    request.on("end", () => {
      uploaded.push(Buffer.concat(body).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  vi.stubEnv("TRACE_TO_LANGSMITH", "1");
  vi.stubEnv("LANGSMITH_CURSOR_API_KEY", "synthetic-key");
  vi.stubEnv("LANGSMITH_CURSOR_ENDPOINT", `http://127.0.0.1:${port}`);
  vi.stubEnv("LANGSMITH_CURSOR_STATE_FILE", join(dir, "state.json"));
  vi.stubEnv("LANGSMITH_CURSOR_LOG_FILE", join(dir, "hook.log"));
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

function config() {
  return {
    ...testConfig(join(dir, "state.json")),
    apiUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    apiKey: "synthetic-key",
  };
}

function save(conversationId: string, prompt: string) {
  return saveTurnForUpload(config(), {
    buffer: turn("g1", T0, { tracingMode: "full", prompt }),
    conversationId,
    turnNum: 1,
    project: "cursor",
  });
}

function ageEverythingUnder(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) ageEverythingUnder(child);
    else if (statSync(child).isFile()) utimesSync(child, THREE_HOURS_AGO, THREE_HOURS_AGO);
  }
}

const sawPrompt = (prompt: string) => () => uploaded.some((body) => body.includes(prompt));

describe("work stranded by a session that never woke its worker", { timeout: 120_000 }, () => {
  async function strand(): Promise<void> {
    worker.start = false;
    expect(await save("stranded-session", "STRANDED_PROMPT")).toBe(true);
    ageEverythingUnder(join(dir, "langsmith_engine"));
    expect(uploaded).toEqual([]);
    worker.start = true;
    worker.launches.length = 0;
  }

  it("is restarted, for its own session, when a later hook finds it older than the sweep threshold", async () => {
    await strand();
    await recoverConversations(config(), "later-session", HOUR);
    expect(worker.launches).toEqual([["engine-worker", dir, "stranded-session"]]);
    expect(await until(sawPrompt("STRANDED_PROMPT"))).toBe(true);
    expect(existsSync(join(dir, "langsmith_engine", "worker.log"))).toBe(true);
  });

  it("is left alone while it is younger than the sweep threshold", async () => {
    await strand();
    await recoverConversations(config(), "later-session", 6 * HOUR);
    expect(worker.launches).toEqual([]);
  });

  it("is uploaded by the background worker of a later session, with no hook-time recovery", async () => {
    await strand();
    expect(await save("later-session", "LATER_PROMPT")).toBe(true);
    expect(await until(sawPrompt("LATER_PROMPT"))).toBe(true);
    expect(await until(sawPrompt("STRANDED_PROMPT"))).toBe(true);
  });
});
