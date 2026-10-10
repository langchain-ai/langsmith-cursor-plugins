import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCaptureStore } from "@langchain/plugins-base/storage/capture";
import { expect, it } from "vitest";
import {
  CURSOR_INTEGRATION,
  CURSOR_STOP_SOURCE_EVENT_ID,
  CURSOR_TURN_ROUTE_DIRECTORY,
  CURSOR_TURN_ROUTE_EVENT_KIND,
  CURSOR_TURN_SOURCE_DIRECTORY,
} from "../src/constants.js";
import {
  captureCursorNativeTurnSource,
  cursorTurnSourceRef,
  readCursorNativeTurnSource,
} from "../src/native-turn-source.js";
import type { CursorNativeTurnSourceInput } from "../src/models/native-turn-source.js";

function makeInput(
  storageRoot: string,
  buffer: CursorNativeTurnSourceInput["buffer"],
): CursorNativeTurnSourceInput {
  return {
    storageRoot,
    accountFingerprint: "native-source-account",
    sessionId: "native-source-session",
    conversationId: "native-source-conversation",
    sourceEventId: CURSOR_STOP_SOURCE_EVENT_ID,
    turnNum: 1,
    buffer,
  };
}

function accountDirectory(
  storageRoot: string,
  directory: string,
  accountFingerprint: string,
): string {
  const accountHash = createHash("sha256").update(accountFingerprint).digest("hex");
  return join(storageRoot, directory, accountHash);
}

it("persists legacy turns as metadata without private content", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "cursor-native-source-"));
  const input = makeInput(storageRoot, {
    generation_id: "legacy-turn",
    startMs: 1000,
    prompt: "legacy private prompt",
    finalText: "legacy private answer",
    thoughts: [{ text: "legacy private thought" }],
    origin: {
      project: "legacy-project",
      customMetadata: { cwd: "/private/legacy-workspace" },
    },
    tools: [
      {
        tool_use_id: "legacy-tool",
        name: "Shell",
        input: { command: "legacy private command" },
        output: "legacy private output",
        endMs: 2000,
      },
    ],
    subagents: [],
  });

  const captured = await captureCursorNativeTurnSource(input);
  const loaded = await readCursorNativeTurnSource(
    storageRoot,
    input.sessionId,
    input.buffer.generation_id,
    input.accountFingerprint,
    captured.sourceRef,
  );
  const saved = JSON.stringify(loaded.source);

  expect(loaded.source.buffer.tracingMode).toBe("metadata");
  expect(saved).not.toContain("legacy private");
  expect(saved).not.toContain("/private/legacy-workspace");
});

it("applies each subagent mode before persisting a full parent turn", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "cursor-native-source-"));
  const input = makeInput(storageRoot, {
    tracingMode: "full",
    generation_id: "full-turn",
    startMs: 1000,
    prompt: "full parent prompt",
    thoughts: [],
    tools: [],
    subagents: [
      {
        tracingMode: "metadata",
        subagent_id: "metadata-child",
        subagent_type: "Task",
        task: "metadata child private task",
        description: "metadata child private description",
        resultText: "metadata child private result",
        systemPrompt: "metadata child private system prompt",
        startMs: 1100,
        tools: [
          {
            tool_use_id: "metadata-tool",
            name: "Shell",
            input: { command: "metadata child private command" },
            output: "metadata child private output",
            endMs: 1200,
          },
        ],
      },
      {
        tracingMode: "full",
        subagent_id: "full-child",
        subagent_type: "Task",
        task: "full child task",
        startMs: 1300,
        tools: [],
      },
    ],
  });

  const captured = await captureCursorNativeTurnSource(input);
  const loaded = await readCursorNativeTurnSource(
    storageRoot,
    input.sessionId,
    input.buffer.generation_id,
    input.accountFingerprint,
    captured.sourceRef,
  );
  const saved = JSON.stringify(loaded.source);

  expect(loaded.source.buffer.tracingMode).toBe("full");
  expect(loaded.source.buffer.subagents[0]?.tracingMode).toBe("metadata");
  expect(loaded.source.buffer.subagents[0]?.tools?.[0]?.input).toEqual({});
  expect(saved).not.toContain("metadata child private");
  expect(saved).toContain("full parent prompt");
  expect(saved).toContain("full child task");
});

it("does not persist off turns", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "cursor-native-source-"));
  const input = makeInput(storageRoot, {
    tracingMode: "off",
    generation_id: "off-turn",
    startMs: 1000,
    thoughts: [],
    tools: [],
    subagents: [],
  });

  await expect(captureCursorNativeTurnSource(input)).rejects.toThrow("off turns");
  const captures = await createCaptureStore(
    accountDirectory(storageRoot, CURSOR_TURN_SOURCE_DIRECTORY, input.accountFingerprint),
  ).enumerate(CURSOR_INTEGRATION, input.sessionId);
  expect(captures).toEqual([]);
});

it("reuses an immutable stop source on retry and separates a new native revision", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "cursor-native-source-retry-"));
  const input = makeInput(storageRoot, {
    tracingMode: "full",
    generation_id: "retry-turn",
    startMs: 1000,
    prompt: "saved prompt",
    thoughts: [],
    tools: [
      {
        tool_use_id: "retry-tool",
        name: "Shell",
        input: { command: "first command" },
        output: "A",
        endMs: 2000,
      },
    ],
    subagents: [],
  });
  input.cwd = "/original/workspace";
  const first = await captureCursorNativeTurnSource(input);

  input.buffer.startMs = 1100;
  input.buffer.tools[0]!.output = "B";
  input.cwd = "/changed/workspace";
  const retry = await captureCursorNativeTurnSource(input);
  expect(retry.sourceRef).toBe(first.sourceRef);
  expect(retry.source).toEqual(first.source);
  expect(retry.route).toEqual(first.route);

  const newer = await captureCursorNativeTurnSource({ ...input, sourceEventId: "stop-revision-2" });
  expect(newer.sourceRef).not.toBe(first.sourceRef);
  expect(newer.source.buffer.tools[0]?.output).toBe("B");
});

it.each([
  {
    label: "another account",
    fingerprint: "foreign-account",
    eventKind: CURSOR_TURN_ROUTE_EVENT_KIND,
  },
  { label: "another event kind", fingerprint: "native-source-account", eventKind: "foreign-route" },
])("rejects route records for $label", async ({ fingerprint, eventKind }) => {
  const storageRoot = mkdtempSync(join(tmpdir(), "cursor-native-source-"));
  const input = makeInput(storageRoot, {
    tracingMode: "metadata",
    generation_id: "routed-turn",
    startMs: 1000,
    thoughts: [],
    tools: [],
    subagents: [],
  });
  const sourceRef = cursorTurnSourceRef(
    input.sessionId,
    input.conversationId,
    input.buffer.generation_id,
    input.accountFingerprint,
    input.sourceEventId,
  );
  await createCaptureStore(
    accountDirectory(storageRoot, CURSOR_TURN_ROUTE_DIRECTORY, input.accountFingerprint),
  ).capture({
    integration: CURSOR_INTEGRATION,
    sessionId: input.sessionId,
    turnId: input.buffer.generation_id,
    eventId: sourceRef,
    runId: sourceRef,
    destinationFingerprint: fingerprint,
    eventKind,
    normalizedPayload: { version: 1, cwd: "/workspace" },
    turnEvidence: { childRunIds: [], closureState: "open" },
    metadataProvenance: {},
    sourceAgeStartedAtMs: input.buffer.startMs,
  });

  await expect(captureCursorNativeTurnSource(input)).rejects.toThrow("route is unavailable");
});
