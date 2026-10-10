import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReconstructionJob } from "@langchain/plugins-base/tracing/reconstruction";
import { expect, it } from "vitest";
import { captureCursorNativeTurnSource } from "../src/native-turn-source.js";
import { initTracing, reconstructCursorTurn } from "../src/langsmith.js";
import type { Config } from "../src/config.js";
import { CURSOR_INTEGRATION } from "../src/constants.js";
import type { TurnBuffer } from "../src/types.js";
import type { TracingEngineSession } from "../src/models/tracing-engine.js";

it("reuses run IDs when it rebuilds a saved turn with model, tool, and subagent runs", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "cursor-run-id-reconstruction-"));
  const cwd = join(storageRoot, "workspace");
  mkdirSync(cwd);
  const sessionId = "saved-source-session";
  const conversationId = "saved-source-conversation";
  const turnId = "saved-source-generation";
  const destinationFingerprint = "saved-source-destination";
  const config: Config = {
    enabled: true,
    defaultMuted: false,
    apiKey: "synthetic-cursor-test-key",
    apiUrl: "http://127.0.0.1:1",
    project: "saved-source-project",
    debug: false,
    stateFilePath: join(storageRoot, "state.json"),
    attachmentsEnabled: false,
    systemPromptEnabled: false,
    cursorDbPath: join(storageRoot, "missing-cursor.db"),
    redact: false,
    sweepIdleMinutes: 30,
  };
  const buffer: TurnBuffer = {
    tracingMode: "full",
    origin: { project: config.project },
    generation_id: turnId,
    turnNum: 1,
    prompt: "Build from the saved source",
    model: "claude-4.6-sonnet-medium-thinking",
    startMs: 1000,
    tools: [
      {
        tool_use_id: "parent-tool-1",
        name: "Shell",
        input: { command: "pwd" },
        output: "/workspace",
        duration: 1,
        endMs: 3000,
      },
    ],
    thoughts: [],
    subagents: [
      {
        tracingMode: "full",
        subagent_id: "subagent-1",
        subagent_type: "general",
        task: "Inspect the saved turn",
        model: "claude-4.6-sonnet-medium-thinking",
        startMs: 3000,
        endMs: 5000,
        status: "completed",
        resultText: "Inspection complete",
        tools: [
          {
            tool_use_id: "child-tool-1",
            name: "Read",
            input: { path: "README.md" },
            output: "content",
            duration: 1,
            endMs: 4500,
          },
        ],
      },
    ],
    finalText: "Done",
    status: "completed",
  };
  const saved = await captureCursorNativeTurnSource({
    storageRoot,
    accountFingerprint: destinationFingerprint,
    sessionId,
    conversationId,
    sourceEventId: "stop",
    turnNum: 1,
    buffer,
    cwd,
  });
  const job: ReconstructionJob = {
    integration: CURSOR_INTEGRATION,
    sessionId,
    accountFingerprint: destinationFingerprint,
    turnId,
    eventId: "saved-source-job",
    sourceRefs: [saved.sourceRef],
    privacyMode: "full",
    turnEvidence: { childRunIds: [], closureState: "authoritative" },
    sourceAgeStartedAtMs: buffer.startMs,
  };
  const options = {
    config,
    cwd,
    destinationFingerprint,
    job,
    session: {} as TracingEngineSession,
    sessionId,
    storageRoot,
  };
  initTracing(config.apiKey, config.apiUrl, undefined, config.redact);

  const first = await reconstructCursorTurn(options);
  const second = await reconstructCursorTurn(options);
  if (first.status !== "ready" || second.status !== "ready") {
    throw new Error("Saved turn reconstruction was deferred");
  }
  const summarize = (outputs: typeof first.outputs) =>
    outputs
      .map((output) => ({
        eventId: output.eventId,
        operation: output.submission.operation,
        runId: output.submission.run.id,
        runName: output.submission.run.name,
        runType: output.submission.run.run_type,
      }))
      .sort(
        (left, right) =>
          left.runId.localeCompare(right.runId) || left.operation.localeCompare(right.operation),
      );
  const firstOutputs = summarize(first.outputs);

  expect(firstOutputs).toEqual(summarize(second.outputs));
  expect(new Set(firstOutputs.map((output) => output.runId)).size).toBeGreaterThan(3);
  expect(firstOutputs.some((output) => output.runType === "llm")).toBe(true);
  expect(firstOutputs.some((output) => output.runType === "tool")).toBe(true);
  expect(firstOutputs.some((output) => output.runName === "general Subagent")).toBe(true);
});

it("does not reconstruct an off subagent under a full parent turn", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "cursor-off-subagent-reconstruction-"));
  const cwd = join(storageRoot, "workspace");
  mkdirSync(cwd);
  const config: Config = {
    enabled: true,
    defaultMuted: false,
    apiKey: "synthetic-cursor-test-key",
    apiUrl: "http://127.0.0.1:1",
    project: "saved-source-project",
    debug: false,
    stateFilePath: join(storageRoot, "state.json"),
    attachmentsEnabled: false,
    systemPromptEnabled: false,
    cursorDbPath: join(storageRoot, "missing-cursor.db"),
    redact: false,
    sweepIdleMinutes: 30,
  };
  const sessionId = "off-subagent-session";
  const turnId = "off-subagent-generation";
  const destinationFingerprint = "off-subagent-destination";
  const buffer: TurnBuffer = {
    tracingMode: "full",
    generation_id: turnId,
    turnNum: 1,
    prompt: "Trace the parent only",
    startMs: 1000,
    tools: [],
    thoughts: [],
    subagents: [
      {
        tracingMode: "off",
        subagent_id: "private-off-subagent",
        subagent_type: "private worker",
        task: "private off task",
        startMs: 1200,
        endMs: 1500,
        status: "completed",
        resultText: "private off result",
        tools: [
          {
            tool_use_id: "private-off-tool",
            name: "Shell",
            input: { command: "private off command" },
            output: "private off output",
            endMs: 1400,
          },
        ],
      },
    ],
    finalText: "Parent complete",
    status: "completed",
  };
  const saved = await captureCursorNativeTurnSource({
    storageRoot,
    accountFingerprint: destinationFingerprint,
    sessionId,
    conversationId: "off-subagent-conversation",
    sourceEventId: "stop",
    turnNum: 1,
    buffer,
    cwd,
  });
  const job: ReconstructionJob = {
    integration: CURSOR_INTEGRATION,
    sessionId,
    accountFingerprint: destinationFingerprint,
    turnId,
    eventId: "off-subagent-job",
    sourceRefs: [saved.sourceRef],
    privacyMode: "full",
    turnEvidence: { childRunIds: [], closureState: "authoritative" },
    sourceAgeStartedAtMs: buffer.startMs,
  };
  initTracing(config.apiKey, config.apiUrl, undefined, config.redact);

  const result = await reconstructCursorTurn({
    config,
    cwd,
    destinationFingerprint,
    job,
    session: {} as TracingEngineSession,
    sessionId,
    storageRoot,
  });
  if (result.status !== "ready") throw new Error("Saved turn reconstruction was deferred");

  expect(saved.source.buffer.subagents).toEqual([]);
  expect(
    result.outputs.some(
      (output) =>
        output.submission.run.name.includes("private worker") ||
        output.submission.run.name === "Shell" ||
        JSON.stringify(output.submission).includes("private off"),
    ),
  ).toBe(false);
});
