import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCaptureStore } from "@langchain/plugins-base/storage/capture";
import { createLangSmithUploadWriter } from "@langchain/plugins-base/tracing/upload";
import { expect, it } from "vitest";
import { MUTED_TRACE_CONTENT } from "../src/privacy.js";
import { withWindowsProcessEnvironment } from "./utils/process-environment.js";
import type {
  CapturedRunPayload,
  CapturedRunRecord,
  Upload,
  UploadPayload,
} from "./models/tracing-engine-stop.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const guard = join(root, "bundle/guard.js");

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function reply(request: IncomingMessage, response: ServerResponse, uploads: Upload[]) {
  const raw = await requestBody(request);
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (request.method === "GET" && path.endsWith("/info")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ batch_ingest_config: { use_multipart_endpoint: false } }));
    return;
  }
  if (/^\/(?:api\/)?runs(?:\/[^/]+)?$/.test(path) && /^(POST|PATCH)$/.test(request.method ?? "")) {
    const payload = (raw ? JSON.parse(raw) : {}) as Record<string, any>;
    uploads.push({
      action: request.method === "POST" ? "post" : "patch",
      runId: typeof payload.id === "string" ? payload.id : path.split("/").at(-1),
      path,
      payload,
    });
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end("{}");
}

function runGuard(
  hook: string,
  input: Record<string, unknown>,
  cwd: string,
  env: NodeJS.ProcessEnv,
  direct = false,
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      direct ? [join(root, "bundle", `${hook}.js`)] : [guard, hook],
      {
        cwd,
        env,
        stdio: ["pipe", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`guard ${hook} exited ${code}: ${stderr}`));
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function waitFor(predicate: () => boolean, uploads: Upload[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(predicate(), JSON.stringify(uploads)).toBe(true);
}

async function waitForReceipts(
  directory: string,
  sessionId: string,
  turnId: string,
  destinationId: string,
): Promise<Awaited<ReturnType<ReturnType<typeof createCaptureStore>["enumerate"]>>> {
  const store = createCaptureStore(directory);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const records = (await store.enumerate("cursor", sessionId)).filter(
      ({ record }) => record.turnId === turnId,
    );
    const outcomes = await Promise.all(
      records.map(({ record }) =>
        store.readOutcome(
          {
            integration: record.integration,
            sessionId: record.sessionId,
            turnId: record.turnId,
            eventId: record.eventId,
          },
          destinationId,
        ),
      ),
    );
    if (
      outcomes.some(
        (outcome) => outcome.status === "settled" && outcome.receipt.outcome !== "delivered",
      )
    ) {
      throw new Error("A captured turn event was dropped before delivery");
    }
    const hasAuthoritativeRootPatch = records.some(({ record }) => {
      const evidence = record.turnEvidence;
      return (
        record.eventKind === "run-patch" &&
        evidence !== null &&
        typeof evidence === "object" &&
        !Array.isArray(evidence) &&
        evidence.rootRunId === record.runId &&
        evidence.closureState === "authoritative"
      );
    });
    const rootPost = records.find(({ record }) => {
      const evidence = record.turnEvidence;
      return (
        record.eventKind === "run-post" &&
        evidence !== null &&
        typeof evidence === "object" &&
        !Array.isArray(evidence) &&
        evidence.rootRunId === record.runId
      );
    });
    const hasSettledRootEndTimePatch = records.some(({ record }) => {
      const evidence = record.turnEvidence;
      const payload = record.normalizedPayload as {
        operation?: unknown;
        patch?: { fields?: unknown };
      };
      return (
        record.eventKind === "run-settlement-patch" &&
        record.runId === rootPost?.record.runId &&
        evidence !== null &&
        typeof evidence === "object" &&
        !Array.isArray(evidence) &&
        evidence.closureState === "authoritative" &&
        payload.operation === "patch" &&
        Array.isArray(payload.patch?.fields) &&
        payload.patch.fields.length === 1 &&
        payload.patch.fields[0] === "end_time"
      );
    });
    if (
      records.length > 0 &&
      hasAuthoritativeRootPatch &&
      hasSettledRootEndTimePatch &&
      outcomes.every((outcome) => outcome.status === "settled")
    ) {
      return records;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Capture receipts did not settle");
}

function ageSavedTurn(stateFile: string, conversationId: string, generationId: string): void {
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as Record<
    string,
    {
      turns: Record<
        string,
        {
          startMs: number;
          tools?: Array<{ endMs: number }>;
          subagents?: Array<{ startMs: number; endMs?: number }>;
        }
      >;
    }
  >;
  const turn = state[conversationId]?.turns[generationId];
  if (!turn) throw new Error("Prompt hook did not save the turn");
  const agedAt = Date.now() - 120_000;
  turn.startMs = agedAt;
  for (const tool of turn.tools ?? []) tool.endMs = agedAt;
  for (const subagent of turn.subagents ?? []) {
    subagent.startMs = agedAt;
    if (subagent.endMs !== undefined) subagent.endMs = agedAt;
  }
  writeFileSync(stateFile, JSON.stringify(state));
}

function rewriteSavedPrompt(
  stateFile: string,
  conversationId: string,
  generationId: string,
  prompt: string,
): void {
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as Record<
    string,
    { turns: Record<string, { prompt: string }> }
  >;
  const turn = state[conversationId]?.turns[generationId];
  if (!turn) throw new Error("Prompt hook did not save the turn");
  turn.prompt = prompt;
  writeFileSync(stateFile, JSON.stringify(state));
}

function writeSystemPrompt(dbPath: string, conversationId: string, content: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
  const blobId = Buffer.from([0xbe, 0xef]);
  const state = Buffer.concat([Buffer.from([0x0a, blobId.length]), blobId]);
  const upsert = db.prepare(
    "INSERT INTO cursorDiskKV (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  upsert.run(
    `composerData:${conversationId}`,
    JSON.stringify({ conversationState: `~${state.toString("base64")}` }),
  );
  upsert.run("agentKv:blob:beef", JSON.stringify({ role: "system", content }));
  db.close();
}

function wireState(runId: string, uploads: Upload[]): UploadPayload | undefined {
  const post = uploads.find((upload) => upload.action === "post" && upload.runId === runId);
  if (!post) return undefined;
  const state: UploadPayload = { ...post.payload };
  for (const upload of uploads) {
    if (upload.action === "patch" && upload.runId === runId) Object.assign(state, upload.payload);
  }
  return state;
}

it.each([
  { kind: "prompt-captured", model: "default", enriched: false, subagent: false, muted: false },
  { kind: "recovered", model: undefined, enriched: false, subagent: false, muted: false },
  { kind: "enriched-subagent", model: "default", enriched: true, subagent: true, muted: false },
  { kind: "metadata-private", model: "default", enriched: false, subagent: true, muted: true },
])(
  "lets a later Stop close a swept $kind trace through the bundled guard",
  async ({ kind, model, enriched, subagent, muted }) => {
    const directory = mkdtempSync(join(tmpdir(), "cursor-stop-regression-"));
    const workspace = join(directory, "workspace");
    const stateFile = join(directory, "state.json");
    const home = join(directory, "home");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(workspace);
    mkdirSync(home);

    const conversationId = `late-stop-${kind}`;
    const generationId = `turn-${kind}`;
    const prompt = muted ? "cursor-metadata-private-marker" : "captured prompt";
    const dbPath = join(directory, "cursor-state.db");
    if (enriched) writeSystemPrompt(dbPath, conversationId, "swept system prompt");
    const now = Date.now();
    if (kind === "recovered") {
      writeFileSync(
        stateFile,
        JSON.stringify({
          [conversationId]: {
            turns: {
              [generationId]: {
                generation_id: generationId,
                turnNum: 1,
                startMs: now - 120_000,
                prompt: "captured prompt",
                tools: [],
                thoughts: [],
                subagents: [],
                tracingMode: "full",
              },
            },
            turn_count: 0,
            turns_started: 1,
            updated: new Date(now).toISOString(),
          },
        }),
      );
    }

    const uploads: Upload[] = [];
    const primaryUploads: Upload[] = [];
    const server = createServer((request, response) => {
      void reply(request, response, uploads);
    });
    const primaryServer = createServer((request, response) => {
      void reply(request, response, primaryUploads);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => primaryServer.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const primaryAddress = primaryServer.address();
    if (
      !address ||
      typeof address === "string" ||
      !primaryAddress ||
      typeof primaryAddress === "string"
    )
      throw new Error("Local upload server did not start");
    const replicaUrl = `http://127.0.0.1:${address.port}`;
    const primaryUrl = `http://127.0.0.1:${primaryAddress.port}`;
    const replica = {
      apiKey: "replica-test-key",
      apiUrl: replicaUrl,
      projectName: "replica-project",
    };
    const destinationId = createLangSmithUploadWriter({
      destinations: [{ apiKey: "", apiUrl: primaryUrl, projectName: "stop-regression" }],
      replicas: [replica],
      redact: true,
    }).destinations[0].id;

    const env = withWindowsProcessEnvironment({
      HOME: home,
      USERPROFILE: home,
      TMPDIR: directory,
      TEMP: directory,
      TMP: directory,
      LANG: "C.UTF-8",
      TRACE_TO_LANGSMITH: "true",
      LANGSMITH_CURSOR_API_KEY: "",
      LANGSMITH_CURSOR_ENDPOINT: primaryUrl,
      LANGSMITH_CURSOR_PROJECT: "stop-regression",
      LANGSMITH_CURSOR_RUNS_ENDPOINTS: JSON.stringify([
        {
          api_key: replica.apiKey,
          api_url: replica.apiUrl,
          project: replica.projectName,
        },
      ]),
      LANGSMITH_CURSOR_STATE_FILE: stateFile,
      LANGSMITH_CURSOR_SWEEP_IDLE_MINUTES: "1",
      LANGSMITH_CURSOR_ATTACHMENTS: "false",
      LANGSMITH_CURSOR_SYSTEM_PROMPT: String(enriched),
      LANGSMITH_CURSOR_DB_PATH: dbPath,
      LANGSMITH_CURSOR_LOG_FILE: join(directory, "hook.log"),
      ...(muted ? { LANGSMITH_CURSOR_DEFAULT_MUTED: "true" } : {}),
    });
    const shared = { workspace_roots: [workspace], session_id: conversationId };

    try {
      if (kind !== "recovered") {
        await runGuard(
          "before-submit-prompt",
          {
            ...shared,
            hook_event_name: "beforeSubmitPrompt",
            conversation_id: conversationId,
            generation_id: generationId,
            model,
            prompt,
          },
          workspace,
          env,
        );
        if (subagent) {
          await runGuard(
            "subagent-start",
            {
              ...shared,
              hook_event_name: "subagentStart",
              conversation_id: conversationId,
              generation_id: generationId,
              model: model ?? "default",
              subagent_id: "subagent-1",
              subagent_type: "general",
              task: "Inspect the buffered change",
              parent_conversation_id: conversationId,
            },
            workspace,
            env,
          );
          await runGuard(
            "subagent-stop",
            {
              ...shared,
              hook_event_name: "subagentStop",
              conversation_id: conversationId,
              generation_id: generationId,
              model: model ?? "default",
              subagent_id: "subagent-1",
              subagent_type: "general",
              status: "completed",
              task: "Inspect the buffered change",
              parent_conversation_id: conversationId,
            },
            workspace,
            env,
          );
        }
        ageSavedTurn(stateFile, conversationId, generationId);
      }

      await runGuard(
        "session-start",
        {
          ...shared,
          hook_event_name: "sessionStart",
          conversation_id: "fresh-conversation",
          generation_id: "fresh-generation",
          model: "default",
        },
        workspace,
        env,
        kind === "recovered",
      );

      const isRoot = (upload: Upload) =>
        upload.payload.extra?.metadata?.thread_id === conversationId &&
        upload.payload.extra?.metadata?.turn_id === generationId &&
        upload.payload.parent_run_id == null;
      await waitFor(
        () =>
          uploads.some((upload) => upload.action === "post" && isRoot(upload)) &&
          uploads.some((upload) => upload.action === "patch" && isRoot(upload)),
        uploads,
      );
      const provisionalPost = uploads.find((upload) => upload.action === "post" && isRoot(upload))!;
      const provisionalPatch = uploads.find(
        (upload) => upload.action === "patch" && isRoot(upload),
      )!;
      expect(provisionalPatch.payload.error).not.toBe("incomplete");
      expect(provisionalPost.runId).toEqual(expect.any(String));
      if (kind === "prompt-captured") {
        expect(JSON.stringify(provisionalPost.payload.inputs)).toContain("captured prompt");
        rewriteSavedPrompt(stateFile, conversationId, generationId, "reconstructed prompt");
      }
      if (enriched) writeSystemPrompt(dbPath, conversationId, "stop system prompt");

      await runGuard(
        "stop",
        {
          ...shared,
          hook_event_name: "stop",
          conversation_id: conversationId,
          generation_id: generationId,
          ...(model === undefined ? {} : { model }),
          status: "completed",
        },
        workspace,
        env,
      );
      const captures = await waitForReceipts(
        directory,
        conversationId,
        generationId,
        destinationId,
      );
      const rootPatches = uploads.filter((upload) => upload.action === "patch" && isRoot(upload));
      expect(rootPatches.length).toBeGreaterThan(1);
      expect(rootPatches.at(-1)?.runId).toBe(provisionalPost.runId);
      expect(rootPatches.at(-1)?.payload.end_time).toEqual(expect.any(Number));
      expect(rootPatches.at(-1)?.payload.error).toBeUndefined();
      expect(uploads.filter((upload) => upload.action === "post" && isRoot(upload)).length).toBe(1);
      expect(primaryUploads).toEqual([]);
      expect(provisionalPost.runId).not.toBeUndefined();
      expect(wireState(provisionalPost.runId!, uploads)?.session_name).toBe("replica-project");
      expect(rootPatches.at(-1)?.payload.session_name).toBe("replica-project");
      expect(wireState(provisionalPost.runId!, uploads)?.parent_run_id).toBeUndefined();
      if (kind === "prompt-captured") {
        expect(JSON.stringify(wireState(provisionalPost.runId!, uploads)?.inputs)).toContain(
          "reconstructed prompt",
        );
      }

      if (enriched) {
        const enrichedPatch = uploads.find(
          (upload) =>
            upload.action === "patch" &&
            JSON.stringify(upload.payload.inputs ?? {}).includes("stop system prompt"),
        );
        expect(enrichedPatch).toBeDefined();
        expect(
          uploads.some(
            (upload) =>
              upload.action === "post" && upload.payload.parent_run_id === provisionalPost.runId,
          ),
        ).toBe(true);
      }

      const runCaptures = captures
        .map(({ record }) => record)
        .filter(
          (record) =>
            record.eventKind === "run-post" ||
            record.eventKind === "run-patch" ||
            record.eventKind === "run-settlement-patch",
        );
      const rootPost = runCaptures.find((record) => {
        const evidence = record.turnEvidence;
        return (
          record.eventKind === "run-post" &&
          evidence !== null &&
          typeof evidence === "object" &&
          !Array.isArray(evidence) &&
          evidence.rootRunId === record.runId
        );
      });
      expect(rootPost).toBeDefined();
      if (muted) {
        const saved = JSON.stringify(captures);
        const sent = JSON.stringify(uploads);
        expect(saved).not.toContain(prompt);
        expect(sent).not.toContain(prompt);
        expect(saved).toContain(MUTED_TRACE_CONTENT);
        expect(sent).toContain(MUTED_TRACE_CONTENT);
      }
      const sourceRootId = rootPost!.runId;
      if (kind === "prompt-captured") {
        const changedPromptPatch = runCaptures.find((record) => {
          if (record.runId !== sourceRootId || record.eventKind !== "run-patch") return false;
          const payload = record.normalizedPayload as {
            operation?: unknown;
            patch?: { fields?: unknown; values?: { inputs?: unknown } };
          };
          return (
            payload.operation === "patch" &&
            Array.isArray(payload.patch?.fields) &&
            payload.patch.fields.includes("inputs") &&
            JSON.stringify(payload.patch.values?.inputs ?? {}).includes("reconstructed prompt")
          );
        });
        expect(changedPromptPatch).toBeDefined();
        expect(
          changedPromptPatch!.dependencies?.some(
            (dependency) => dependency.eventId === rootPost!.eventId,
          ),
        ).toBe(true);
      }
      const authoritativeRootPatch = runCaptures.find((record) => {
        const evidence = record.turnEvidence;
        return (
          record.eventKind === "run-patch" &&
          evidence !== null &&
          typeof evidence === "object" &&
          !Array.isArray(evidence) &&
          evidence.rootRunId === sourceRootId &&
          evidence.closureState === "authoritative"
        );
      });
      const childPosts = runCaptures.filter((record) => {
        const evidence = record.turnEvidence;
        return (
          record.eventKind === "run-post" &&
          record.runId !== sourceRootId &&
          evidence !== null &&
          typeof evidence === "object" &&
          !Array.isArray(evidence) &&
          evidence.rootRunId === sourceRootId
        );
      });
      const capturedRunRecords = runCaptures.map(
        (record) => record as unknown as CapturedRunRecord,
      );
      const subagentPosts = capturedRunRecords.filter(
        (record) =>
          record.eventKind === "run-post" && record.metadataProvenance.subagentId === "subagent-1",
      );
      expect(authoritativeRootPatch).toBeDefined();
      if (subagent) {
        expect(subagentPosts).toHaveLength(1);
        const subagentPost = subagentPosts[0]!;
        const subagentChildPosts = capturedRunRecords.filter((record) => {
          if (record.eventKind !== "run-post") return false;
          const payload = record.normalizedPayload as unknown as CapturedRunPayload;
          return payload.run?.parent_run_id === subagentPost.runId;
        });
        expect(subagentChildPosts.length).toBeGreaterThan(0);
      }
      const closureDependencies = new Set(
        authoritativeRootPatch!.dependencies?.map((dependency) => dependency.eventId),
      );
      expect(closureDependencies.has(rootPost!.eventId)).toBe(true);
      if (subagent) {
        const subagentPost = subagentPosts[0]!;
        expect(closureDependencies.has(subagentPost.eventId)).toBe(true);
      }
      expect(childPosts.length).toBeGreaterThan(0);
      expect(childPosts.every((child) => closureDependencies.has(child.eventId))).toBe(true);

      const accountFingerprint = createLangSmithUploadWriter({
        destinations: [{ apiKey: "", apiUrl: primaryUrl, projectName: "stop-regression" }],
        replicas: [replica],
        redact: true,
      }).accountFingerprint;
      expect(
        runCaptures.every((record) => record.destinationFingerprint === accountFingerprint),
      ).toBe(true);
      const wireSummary = uploads.map(({ action, path, runId }) => ({ action, path, runId }));
      const captureSummary = runCaptures.map(({ eventId, eventKind, runId, normalizedPayload }) => {
        const payload = normalizedPayload as {
          operation?: unknown;
          patch?: { fields?: unknown };
        };
        return {
          eventId,
          eventKind,
          runId,
          operation: payload.operation,
          fields: payload.patch?.fields,
        };
      });
      expect(uploads, JSON.stringify({ wireSummary, captureSummary })).toHaveLength(
        runCaptures.length,
      );
      const rootPostIndex = uploads.findIndex(
        (upload) =>
          upload.action === "post" && isRoot(upload) && upload.runId === provisionalPost.runId,
      );
      const childPostIndices = uploads
        .map((upload, index) => ({ upload, index }))
        .filter(
          ({ upload }) =>
            upload.action === "post" &&
            !isRoot(upload) &&
            upload.payload.extra?.metadata?.thread_id === conversationId &&
            upload.payload.extra?.metadata?.turn_id === generationId,
        )
        .map(({ index }) => index);
      const finalPatchIndex = uploads.lastIndexOf(rootPatches.at(-1)!);
      expect(rootPostIndex).toBeGreaterThanOrEqual(0);
      expect(childPostIndices.length).toBeGreaterThan(0);
      expect(rootPostIndex).toBeLessThan(Math.min(...childPostIndices));
      expect(Math.max(...childPostIndices)).toBeLessThan(finalPatchIndex);
    } finally {
      await Promise.all(
        [server, primaryServer].map(
          (activeServer) => new Promise<void>((resolve) => activeServer.close(() => resolve())),
        ),
      );
    }
  },
  30_000,
);
