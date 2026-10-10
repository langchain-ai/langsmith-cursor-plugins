import { createServer } from "node:http";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCaptureStore } from "@langchain/plugins-base/storage/capture";
import { createRunIdentity } from "@langchain/plugins-base/tracing/lifecycle";
import { createLangSmithUploadWriter } from "@langchain/plugins-base/tracing/upload";
import { CaptureWakeError } from "@langchain/plugins-base/tracing";
import { loadConfig } from "../src/config.js";
import {
  createCursorTracingSession,
  parseCursorEngineWorkerArguments,
} from "../src/tracing-engine.js";

let server: ReturnType<typeof createServer> | undefined;
const requests: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  requests.length = 0;
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

it("rejects a malformed project selector in worker arguments", () => {
  expect(() =>
    parseCursorEngineWorkerArguments(["scope-session", "/workspace", "project\nchanged"]),
  ).toThrow("Shared trace worker project is invalid");
  expect(
    parseCursorEngineWorkerArguments(["scope-session", "/workspace", "saved-project"]),
  ).toEqual({
    sessionId: "scope-session",
    cwd: "/workspace",
    project: "saved-project",
  });
});

async function captureRoot(
  tracing: NonNullable<ReturnType<typeof createCursorTracingSession>>,
  sessionId: string,
  turnId: string,
  runId: string,
): Promise<void> {
  try {
    const result = await tracing.session.capture({
      turnId,
      eventId: "same-root-event",
      submission: {
        operation: "post",
        integration: "cursor",
        privacyMode: "full",
        metadata: {
          integration: "cursor",
          threadId: sessionId,
          turnId,
          agentType: "root",
          runType: "root",
        },
        run: {
          ...createRunIdentity({ id: runId, start_time: Date.now() }),
          name: "Scoped root",
          run_type: "chain",
          inputs: { prompt: turnId },
        },
      },
      turnEvidence: { rootRunId: runId, childRunIds: [], closureState: "open" },
    });
    expect(result.status).toBe("published");
  } catch (error) {
    expect(error).toBeInstanceOf(CaptureWakeError);
    expect(error).toMatchObject({ captureResult: { status: "published" } });
  }
}

it("does not reuse a persisted run post after the upload account changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cursor-engine-scope-"));
  const home = join(directory, "home");
  const workspace = join(directory, "workspace");
  mkdirSync(home);
  mkdirSync(workspace);
  server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      requests.push(`${request.method} ${request.url}`);
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      request.method === "GET" && request.url?.endsWith("/info")
        ? JSON.stringify({ batch_ingest_config: { use_multipart_endpoint: false } })
        : "{}",
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local upload server did not start");
  const apiUrl = `http://127.0.0.1:${address.port}`;
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("TEMP", directory);
  vi.stubEnv("TMP", directory);
  vi.stubEnv("TRACE_TO_LANGSMITH", "true");
  vi.stubEnv("LANGSMITH_CURSOR_API_KEY", "test-only-key");
  vi.stubEnv("LANGSMITH_CURSOR_ENDPOINT", apiUrl);
  vi.stubEnv("LANGSMITH_CURSOR_PROJECT", "project-one");
  vi.stubEnv("LANGSMITH_CURSOR_STATE_FILE", join(directory, "state.json"));
  vi.stubEnv("LANGSMITH_CURSOR_REDACT_EXTRA", "[]");

  const session = createCursorTracingSession(
    loadConfig({ cwd: workspace }),
    "scope-session",
    workspace,
    () => 0,
  );
  expect(session).toBeDefined();
  const writer = createLangSmithUploadWriter({
    destinations: [{ apiKey: "test-only-key", apiUrl, projectName: "project-one" }],
    redact: true,
    redactExtraRules: [],
  });
  expect(session!.destinationFingerprint).toBe(writer.accountFingerprint);
  const runId = "50000000-0000-4000-8000-000000000001";
  const startTime = Date.now();
  const identity = createRunIdentity({ id: runId, start_time: startTime });
  const metadataProvenance = {
    integration: "cursor",
    threadId: "scope-session",
    turnId: "scope-turn",
    turnNumber: 1,
    agentType: "root",
    runType: "root",
    base: { repository_name: "scope-test", ls_attribution_identifier: "scope-test" },
  } as const;
  const store = createCaptureStore(directory);
  const capture = session!.session.capture({
    turnId: "scope-turn",
    eventId: "scope-root-post",
    submission: {
      operation: "post",
      integration: "cursor",
      privacyMode: "full",
      metadata: metadataProvenance,
      run: {
        ...identity,
        name: "Scoped root",
        run_type: "chain",
        inputs: { prompt: "account one" },
      },
    },
    turnEvidence: { rootRunId: runId, childRunIds: [], closureState: "open" },
  });
  await expect(capture).rejects.toMatchObject({
    name: "CaptureWakeError",
    captureResult: { status: "published" },
  });
  const persistedBeforeSwitch = await store.enumerate("cursor", "scope-session");
  expect(persistedBeforeSwitch.map(({ record }) => record.eventId)).toEqual(["scope-root-post"]);
  expect(persistedBeforeSwitch[0]?.record.destinationFingerprint).toBe(writer.accountFingerprint);
  vi.stubEnv("LANGSMITH_CURSOR_PROJECT", "project-two");
  vi.stubEnv("LANGSMITH_CURSOR_API_KEY", "test-only-key-two");

  expect(await session!.session.drain()).toBe("scope-mismatch");
  expect(requests).toEqual([]);
  const persisted = await store.enumerate("cursor", "scope-session");
  expect(persisted.map(({ record }) => record.eventId)).toEqual(["scope-root-post"]);
  expect(persisted[0]?.record.destinationFingerprint).toBe(writer.accountFingerprint);
  expect(
    await store.readOutcome(
      {
        integration: "cursor",
        sessionId: "scope-session",
        turnId: "scope-turn",
        eventId: "scope-root-post",
      },
      writer.destinations[0]!.id,
    ),
  ).toMatchObject({ status: "pending" });
});

it("keeps shared captures isolated by session and turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cursor-engine-turn-scope-"));
  const home = join(directory, "home");
  const workspace = join(directory, "workspace");
  mkdirSync(home);
  mkdirSync(workspace);
  server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      requests.push(`${request.method} ${request.url}`);
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      request.method === "GET" && request.url?.endsWith("/info")
        ? JSON.stringify({ batch_ingest_config: { use_multipart_endpoint: false } })
        : "{}",
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local upload server did not start");
  const apiUrl = `http://127.0.0.1:${address.port}`;
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("TEMP", directory);
  vi.stubEnv("TMP", directory);
  vi.stubEnv("TRACE_TO_LANGSMITH", "true");
  vi.stubEnv("LANGSMITH_CURSOR_API_KEY", "test-only-key");
  vi.stubEnv("LANGSMITH_CURSOR_ENDPOINT", apiUrl);
  vi.stubEnv("LANGSMITH_CURSOR_PROJECT", "scope-project");
  vi.stubEnv("LANGSMITH_CURSOR_STATE_FILE", join(directory, "state.json"));
  vi.stubEnv("LANGSMITH_CURSOR_REDACT_EXTRA", "[]");

  const config = loadConfig({ cwd: workspace });
  const firstSession = createCursorTracingSession(
    config,
    "session-a",
    workspace,
    () => process.pid + 1,
  )!;
  const secondSession = createCursorTracingSession(
    config,
    "session-b",
    workspace,
    () => process.pid + 1,
  )!;
  await captureRoot(firstSession, "session-a", "turn-a", "60000000-0000-4000-8000-000000000001");
  await captureRoot(firstSession, "session-a", "turn-b", "60000000-0000-4000-8000-000000000002");
  await captureRoot(secondSession, "session-b", "turn-a", "60000000-0000-4000-8000-000000000003");

  const store = createCaptureStore(directory);
  const writer = createLangSmithUploadWriter({
    destinations: [{ apiKey: "test-only-key", apiUrl, projectName: "scope-project" }],
    redact: true,
    redactExtraRules: [],
  });
  const firstRecords = await store.enumerate("cursor", "session-a");
  const secondRecords = await store.enumerate("cursor", "session-b");
  expect(firstRecords.map(({ record }) => record.turnId)).toEqual(["turn-a", "turn-b"]);
  expect(secondRecords.map(({ record }) => record.turnId)).toEqual(["turn-a"]);

  await secondSession.session.drain();
  expect(requests).toHaveLength(1);
  for (const { record } of firstRecords) {
    expect(
      await store.readOutcome(
        {
          integration: record.integration,
          sessionId: record.sessionId,
          turnId: record.turnId,
          eventId: record.eventId,
        },
        writer.destinations[0]!.id,
      ),
    ).toMatchObject({ status: "pending" });
  }

  await firstSession.session.drain();
  expect(requests).toHaveLength(3);
  for (const { record } of [...firstRecords, ...secondRecords]) {
    expect(
      await store.readOutcome(
        {
          integration: record.integration,
          sessionId: record.sessionId,
          turnId: record.turnId,
          eventId: record.eventId,
        },
        writer.destinations[0]!.id,
      ),
    ).toMatchObject({ status: "settled", receipt: { outcome: "delivered" } });
  }
});
