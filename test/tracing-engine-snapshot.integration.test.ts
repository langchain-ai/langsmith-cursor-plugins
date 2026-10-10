import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCaptureStore, type StoredCapture } from "@langchain/plugins-base/storage/capture";
import { createRunIdentity } from "@langchain/plugins-base/tracing/lifecycle";
import { afterEach, expect, it, vi } from "vitest";
import type { RunTree } from "langsmith";
import type { SnapshotPatchSubmission, SnapshotTestRun } from "./models/tracing-engine-snapshot.js";
import { codingAgentMetadata } from "../src/metadata.js";
import {
  CURSOR_INTEGRATION,
  CURSOR_RUN_PATCH_EVENT_KIND,
  CURSOR_RUN_POST_EVENT_KIND,
} from "../src/constants.js";
import { loadConfig } from "../src/config.js";
import { createRunTreeCapture, createCursorTracingSession } from "../src/tracing-engine.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function makeRun(
  sessionId: string,
  turnId: string,
  id: string,
  runType: "chain" | "tool",
  startTime: number,
  parent?: SnapshotTestRun,
): SnapshotTestRun {
  const identity = createRunIdentity({
    id,
    start_time: startTime,
    ...(parent === undefined ? {} : { parent: parent.identity }),
  });
  const name = runType === "chain" ? "Cursor Turn" : "Bash";
  const payload: Record<string, unknown> = {
    ...identity,
    name,
    run_type: runType,
    inputs: runType === "chain" ? { prompt: "original prompt" } : { command: "pwd" },
    outputs: { result: "A" },
  };
  const metadata = codingAgentMetadata({
    threadId: sessionId,
    turnId,
    turnNumber: 1,
    agentType: "root",
    runType: runType === "chain" ? "root" : "tool",
    ...(runType === "tool" ? { toolName: "Bash" } : {}),
    base: { repository_name: "snapshot-test", ls_attribution_identifier: "snapshot-test" },
  });
  const run = {
    id,
    name,
    run_type: runType,
    start_time: startTime,
    end_time: undefined,
    error: undefined,
    parent_run: parent?.run,
    child_runs: [] as RunTree[],
    extra: { metadata },
    toJSON: () => payload,
  } as unknown as RunTree;
  if (parent) parent.run.child_runs!.push(run);
  return { run, payload, identity };
}

function patchSubmission(record: StoredCapture): SnapshotPatchSubmission {
  const payload = record.normalizedPayload as {
    patch?: { fields?: unknown; values?: unknown };
  };
  const patch = payload.patch;
  if (!Array.isArray(patch?.fields) || !patch.values || typeof patch.values !== "object") {
    throw new Error("Stored snapshot revision is invalid");
  }
  return { fields: patch.fields as string[], values: patch.values as Record<string, unknown> };
}

it("orders A to B to A snapshots and retains parent-child dependencies after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cursor-snapshot-revision-"));
  const home = join(directory, "home");
  const workspace = join(directory, "workspace");
  mkdirSync(home);
  mkdirSync(workspace);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("TEMP", directory);
  vi.stubEnv("TMP", directory);
  vi.stubEnv("TMPDIR", directory);
  vi.stubEnv("TRACE_TO_LANGSMITH", "true");
  vi.stubEnv("LANGSMITH_CURSOR_API_KEY", "snapshot-test-key");
  vi.stubEnv("LANGSMITH_CURSOR_ENDPOINT", "http://127.0.0.1:1");
  vi.stubEnv("LANGSMITH_CURSOR_PROJECT", "snapshot-project");
  vi.stubEnv("LANGSMITH_CURSOR_STATE_FILE", join(directory, "state.json"));
  vi.stubEnv("LANGSMITH_CURSOR_REDACT_EXTRA", "[]");
  const clock = vi.spyOn(Date, "now");
  const sessionId = "snapshot-session";
  const turnId = "snapshot-turn";
  const rootId = "70000000-0000-4000-8000-000000000001";
  const childId = "70000000-0000-4000-8000-000000000002";
  const config = loadConfig({ cwd: workspace });
  const createCapture = () => {
    const tracing = createCursorTracingSession(config, sessionId, workspace, () => {
      throw new Error("worker startup failed");
    });
    if (!tracing) throw new Error("Cursor tracing session was not created");
    return createRunTreeCapture({
      session: tracing.session,
      sessionId,
      turnId,
      privacyMode: "full",
      closureState: "authoritative",
      storageRoot: tracing.storageRoot,
      destinationFingerprint: tracing.destinationFingerprint,
    });
  };
  const store = createCaptureStore(directory);

  clock.mockReturnValue(1000);
  const firstCapture = createCapture();
  const root = makeRun(sessionId, turnId, rootId, "chain", 100);
  const child = makeRun(sessionId, turnId, childId, "tool", 200, root);
  await firstCapture(root.run, "post");
  clock.mockReturnValue(1100);
  await firstCapture(child.run, "post");
  clock.mockReturnValue(3000);
  child.payload.outputs = { result: "B" };
  await firstCapture(child.run, "patch");
  clock.mockReturnValue(2000);
  child.payload.outputs = { result: "A" };
  await firstCapture(child.run, "patch");

  root.payload.inputs = { prompt: "changed prompt" };
  root.payload.end_time = 500;
  root.run.end_time = 500;
  clock.mockReturnValue(4000);
  await firstCapture(root.run, "patch", { excludeInputs: true });

  let records = (await store.enumerate(CURSOR_INTEGRATION, sessionId))
    .map(({ record }) => record)
    .filter((record) => record.turnId === turnId);
  const rootPost = records.find(
    (record) => record.runId === rootId && record.eventKind === CURSOR_RUN_POST_EVENT_KIND,
  );
  const childPost = records.find(
    (record) => record.runId === childId && record.eventKind === CURSOR_RUN_POST_EVENT_KIND,
  );
  const childRevisions = records
    .filter(
      (record) => record.runId === childId && record.eventKind === CURSOR_RUN_PATCH_EVENT_KIND,
    )
    .sort((left, right) => left.eventId.localeCompare(right.eventId));
  expect(rootPost).toBeDefined();
  expect(childPost?.dependencies).toContainEqual({
    integration: CURSOR_INTEGRATION,
    sessionId,
    turnId,
    eventId: rootPost!.eventId,
  });
  expect(childRevisions).toHaveLength(2);
  expect(childRevisions[0]!.capturedAtMs).toBeGreaterThan(childRevisions[1]!.capturedAtMs);
  expect(childRevisions.map((record) => patchSubmission(record).values.outputs)).toEqual([
    { result: "B" },
    { result: "A" },
  ]);
  expect(childRevisions[1]?.dependencies).toContainEqual({
    integration: CURSOR_INTEGRATION,
    sessionId,
    turnId,
    eventId: childRevisions[0]!.eventId,
  });

  const rootRevisions = records
    .filter((record) => record.runId === rootId && record.eventKind === CURSOR_RUN_PATCH_EVENT_KIND)
    .sort((left, right) => left.eventId.localeCompare(right.eventId));
  const firstRootRevision = rootRevisions.at(-1)!;
  expect(patchSubmission(firstRootRevision).fields).toEqual(["end_time"]);
  expect(firstRootRevision.dependencies).toContainEqual({
    integration: CURSOR_INTEGRATION,
    sessionId,
    turnId,
    eventId: childRevisions[1]!.eventId,
  });

  clock.mockReturnValue(5000);
  const restartedCapture = createCapture();
  const restartedRoot = makeRun(sessionId, turnId, rootId, "chain", 100);
  const restartedChild = makeRun(sessionId, turnId, childId, "tool", 200, restartedRoot);
  await restartedCapture(restartedChild.run, "post");
  records = (await store.enumerate(CURSOR_INTEGRATION, sessionId))
    .map(({ record }) => record)
    .filter((record) => record.turnId === turnId);
  const restartedChildHead = records
    .filter(
      (record) => record.runId === childId && record.eventKind === CURSOR_RUN_PATCH_EVENT_KIND,
    )
    .sort((left, right) => left.eventId.localeCompare(right.eventId))
    .at(-1)!;
  expect(restartedChildHead.eventId).not.toBe(childRevisions.at(-1)!.eventId);
  expect(restartedChildHead.dependencies).toContainEqual({
    integration: CURSOR_INTEGRATION,
    sessionId,
    turnId,
    eventId: firstRootRevision.eventId,
  });
  expect(patchSubmission(restartedChildHead).fields).toEqual([]);

  restartedRoot.payload.end_time = 500;
  restartedRoot.run.end_time = 500;
  clock.mockReturnValue(6000);
  await restartedCapture(restartedRoot.run, "patch", { excludeInputs: true });
  records = (await store.enumerate(CURSOR_INTEGRATION, sessionId))
    .map(({ record }) => record)
    .filter((record) => record.turnId === turnId);
  const finalRootHead = records
    .filter((record) => record.runId === rootId && record.eventKind === CURSOR_RUN_PATCH_EVENT_KIND)
    .sort((left, right) => left.eventId.localeCompare(right.eventId))
    .at(-1)!;
  expect(patchSubmission(finalRootHead).fields).toEqual([]);
  expect(finalRootHead.dependencies).toContainEqual({
    integration: CURSOR_INTEGRATION,
    sessionId,
    turnId,
    eventId: restartedChildHead.eventId,
  });
  expect(finalRootHead.turnEvidence).toMatchObject({ closureState: "authoritative" });
});

it("propagates capture errors that are not worker wake failures", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cursor-snapshot-capture-error-"));
  const failure = new Error("capture failed");
  const captureSnapshot = vi.fn().mockRejectedValue(failure);
  const capture = createRunTreeCapture({
    session: { captureSnapshot } as unknown as Parameters<
      typeof createRunTreeCapture
    >[0]["session"],
    sessionId: "capture-error-session",
    turnId: "capture-error-turn",
    privacyMode: "full",
    closureState: "authoritative",
    storageRoot: directory,
    destinationFingerprint: "capture-error-destination",
  });
  const run = makeRun(
    "capture-error-session",
    "capture-error-turn",
    "70000000-0000-4000-8000-000000000003",
    "chain",
    300,
  );

  await expect(capture(run.run, "post")).rejects.toBe(failure);
  expect(captureSnapshot).toHaveBeenCalledTimes(1);
});
