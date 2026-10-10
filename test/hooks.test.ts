import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadState, saveState } from "../src/state.js";
import { runSweep } from "../src/sweep.js";
import { originFromConfig } from "../src/turn-origin.js";
import type { TurnBuffer } from "../src/types.js";
import type { Config } from "../src/config.js";
import { HOUR, MINUTE, T0, conversation, testConfig, turn } from "./utils/state.js";

const harness = vi.hoisted(() => ({
  input: {} as Record<string, unknown>,
  config: undefined as Config | undefined,
  uploadError: undefined as Error | undefined,
  uploadAccepted: true,
  reconstructionError: undefined as Error | undefined,
  reconstructionStatus: "published" as "published" | "deferred",
  initTracing: vi.fn(),
  uploadTurn: vi.fn(async () => {
    if (harness.uploadError) throw harness.uploadError;
    return harness.uploadAccepted;
  }),
  queueReconstruction: vi.fn(async () => {
    if (harness.reconstructionError) throw harness.reconstructionError;
    return { status: harness.reconstructionStatus };
  }),
  launchSweepWorker: vi.fn(() => 123),
  captureTurnSource: vi.fn(
    async (input: { buffer: { tracingMode?: string; prompt?: string } }) => ({
      sourceRef: "saved-source",
      source: { buffer: structuredClone(input.buffer) },
    }),
  ),
}));

vi.mock("../src/utils/stdin.js", () => ({ readStdin: async () => harness.input }));
vi.mock("../src/utils/hook-init.js", () => ({ initHook: () => harness.config ?? null }));
vi.mock("../src/config.js", () => ({ loadConfig: () => harness.config }));
vi.mock("../src/conversation-steps.js", () => ({ resolveTurnSteps: () => undefined }));
vi.mock("../src/langsmith.js", () => ({
  initTracing: harness.initTracing,
  uploadTurn: harness.uploadTurn,
}));
vi.mock("../src/tracing-engine.js", () => ({
  createCursorTracingSession: () => ({
    session: { queueReconstruction: harness.queueReconstruction },
    storageRoot: "/tmp/cursor-hook-test",
    destinationFingerprint: "cursor-hook-test-account",
  }),
  cursorStopReconstructionJobEventId: () => "saved-job",
  launchCursorSweepWorker: harness.launchSweepWorker,
  parseCursorEngineWorkerArguments: vi.fn(),
  runCursorEngineWorker: vi.fn(),
}));
vi.mock("../src/native-turn-source.js", () => ({
  captureCursorNativeTurnSource: harness.captureTurnSource,
  readCursorEarlyNativeTurnSources: vi.fn(async () => []),
  mergeCursorEarlyToolBuffer: (_conversationId: string, buffer: TurnBuffer) => buffer,
}));

const HOOKS = {
  stop: () => import("../src/hooks/stop.js"),
  "session-start": () => import("../src/hooks/session-start.js"),
  "post-tool-use": () => import("../src/hooks/post-tool-use.js"),
};

async function runHook(name: keyof typeof HOOKS): Promise<void> {
  vi.resetModules();
  const hook = await HOOKS[name]();
  await hook.finished;
}

describe("hook wiring against the on-disk state file", () => {
  let dir: string;
  let stateFilePath: string;
  const savedPolicy = process.env.LANGSMITH_CURSOR_PRIVACY_FILE;
  const savedLogFile = process.env.LANGSMITH_CURSOR_LOG_FILE;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hook-wiring-"));
    stateFilePath = join(dir, "langsmith-state.json");
    process.env.LANGSMITH_CURSOR_PRIVACY_FILE = join(dir, "absent-privacy.json");
    process.env.LANGSMITH_CURSOR_LOG_FILE = join(dir, "hook.log");
    harness.uploadError = undefined;
    harness.uploadAccepted = true;
    harness.reconstructionError = undefined;
    harness.reconstructionStatus = "published";
    harness.initTracing.mockClear();
    harness.uploadTurn.mockClear();
    harness.queueReconstruction.mockClear();
    harness.launchSweepWorker.mockClear();
    harness.captureTurnSource.mockClear();
    harness.config = testConfig(stateFilePath);
    harness.input = {
      hook_event_name: "stop",
      conversation_id: "live",
      generation_id: "g1",
      model: "default",
      status: "completed",
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0 + 3 * HOUR);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (savedPolicy === undefined) delete process.env.LANGSMITH_CURSOR_PRIVACY_FILE;
    else process.env.LANGSMITH_CURSOR_PRIVACY_FILE = savedPolicy;
    if (savedLogFile === undefined) delete process.env.LANGSMITH_CURSOR_LOG_FILE;
    else process.env.LANGSMITH_CURSOR_LOG_FILE = savedLogFile;
    rmSync(dir, { recursive: true, force: true });
  });

  function seedLiveTurn(): void {
    saveState(stateFilePath, {
      live: conversation([
        turn("g1", T0, {
          tracingMode: "full",
          prompt: "trace me",
          origin: savedOrigin("live", "g1"),
        }),
      ]),
    });
    vi.setSystemTime(T0 + MINUTE);
  }

  function savedOrigin(conversationId: string, generationId: string) {
    return originFromConfig(harness.config!, {
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: conversationId,
      generation_id: generationId,
      model: "default",
      workspace_roots: [dir],
    });
  }

  function seedStrandedTurn(): void {
    saveState(stateFilePath, {
      stranded: conversation([
        turn("gs", T0, { tracingMode: "full", origin: savedOrigin("stranded", "gs") }),
      ]),
    });
  }

  function sweepAsCaller(nowMs: number) {
    return runSweep({
      config: harness.config!,
      input: {
        hook_event_name: "postToolUse",
        conversation_id: "caller",
        generation_id: "gc",
        model: "default",
      },
      nowMs,
    });
  }

  it("queues its saved source before clearing the completed turn", async () => {
    seedLiveTurn();

    await runHook("stop");

    expect(harness.uploadTurn).not.toHaveBeenCalled();
    expect(harness.captureTurnSource).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "live",
        sessionId: "live",
        turnNum: 1,
        buffer: expect.objectContaining({ prompt: "trace me" }),
      }),
    );
    expect(harness.queueReconstruction).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: "g1",
        sourceRefs: ["saved-source"],
        privacyMode: "full",
        turnEvidence: { childRunIds: [], closureState: "authoritative" },
      }),
    );
    const after = loadState(stateFilePath);
    expect(after.live).toMatchObject({ turns: {}, turn_count: 1 });
    expect(after.live.pending).toBeUndefined();
    expect(harness.launchSweepWorker).toHaveBeenCalledWith(harness.config, harness.input);
  });

  it("holds the turn pending when Stop cannot queue its reconstruction", async () => {
    seedLiveTurn();
    harness.reconstructionError = new Error("queue rejected");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await runHook("stop");

    const after = loadState(stateFilePath);
    expect(after.live.pending!.g1.attempts).toBe(1);
    expect(after.live.pending!.g1.buffer.prompt).toBe("trace me");
    expect(harness.queueReconstruction).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("keeps an unroutable legacy turn pending and still schedules the sweep worker", async () => {
    saveState(stateFilePath, {
      live: conversation([turn("g1", T0, { tracingMode: "full", prompt: "legacy turn" })]),
    });
    vi.setSystemTime(T0 + MINUTE);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await runHook("stop");

    expect(loadState(stateFilePath).live?.pending?.g1?.buffer.prompt).toBe("legacy turn");
    expect(harness.captureTurnSource).not.toHaveBeenCalled();
    expect(harness.launchSweepWorker).toHaveBeenCalledWith(harness.config, harness.input);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("holds the turn pending when the reconstruction queue refuses it", async () => {
    seedLiveTurn();
    harness.reconstructionStatus = "deferred";
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await runHook("stop");

    const after = loadState(stateFilePath);
    expect(after.live.pending!.g1.attempts).toBe(1);
    expect(after.live.pending!.g1.buffer.prompt).toBe("trace me");
    expect(harness.queueReconstruction).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("schedules another thread's stranded turn from the stop hook", async () => {
    saveState(stateFilePath, {
      live: conversation([
        turn("g1", T0 + 3 * HOUR, {
          tracingMode: "full",
          origin: savedOrigin("live", "g1"),
        }),
      ]),
      stranded: conversation([
        turn("gs", T0, { tracingMode: "full", origin: savedOrigin("stranded", "gs") }),
      ]),
    });

    await runHook("stop");

    expect(harness.launchSweepWorker).toHaveBeenCalledWith(harness.config, harness.input);
    expect(harness.uploadTurn).not.toHaveBeenCalled();
    expect(harness.queueReconstruction).toHaveBeenCalledTimes(1);
    expect(harness.queueReconstruction.mock.calls[0]?.[0]).toMatchObject({
      turnId: "g1",
      sourceRefs: ["saved-source"],
    });
    const after = loadState(stateFilePath);
    expect(after.stranded).toMatchObject({ turns: { gs: expect.any(Object) }, turn_count: 0 });
    expect(after.stranded.pending).toBeUndefined();
  });

  it("schedules a state-pruning sweep from the session-start hook", async () => {
    seedStrandedTurn();
    harness.input = {
      hook_event_name: "sessionStart",
      conversation_id: "fresh",
      generation_id: "gf",
      model: "default",
    };

    await runHook("session-start");

    expect(harness.launchSweepWorker).toHaveBeenCalledWith(harness.config, harness.input, true);
    expect(harness.uploadTurn).not.toHaveBeenCalled();
    expect(loadState(stateFilePath).stranded.turn_count).toBe(0);
  });

  it("buffers the tool call and leaves a stranded turn for a sweeping hook", async () => {
    seedStrandedTurn();
    harness.input = {
      hook_event_name: "postToolUse",
      conversation_id: "live",
      generation_id: "g1",
      model: "default",
      tool_name: "Read",
      tool_use_id: "t1",
      tool_input: { path: "a.ts" },
      tool_output: "{}",
    };

    await runHook("post-tool-use");

    const after = loadState(stateFilePath);
    expect(after.live.turns.g1.tools.map((t) => t.name)).toEqual(["Read"]);
    expect(Object.keys(after.stranded.turns)).toEqual(["gs"]);
    expect(harness.uploadTurn).not.toHaveBeenCalled();
  });

  it("keeps a failed sweep upload pending for a later retry", async () => {
    saveState(stateFilePath, {
      stranded: conversation([], {
        turn_count: 1,
        pending: {
          gs: {
            buffer: turn("gs", T0, {
              tracingMode: "full",
              origin: savedOrigin("stranded", "gs"),
            }),
            turnNum: 1,
            claimedAt: T0,
            attempts: 1,
          },
        },
      }),
    });
    harness.uploadError = new Error("upload rejected");

    const uploaded = await sweepAsCaller(T0 + 3 * HOUR);

    expect(uploaded).toEqual([]);
    const after = loadState(stateFilePath);
    expect(after.stranded.pending!.gs).toMatchObject({ attempts: 2, claimedAt: T0 + 3 * HOUR });
  });

  it("uploads the finished turn when a stop lands after a premature sweep", async () => {
    saveState(stateFilePath, {
      live: conversation([
        turn("g1", T0, {
          tracingMode: "full",
          prompt: "think for a long time",
          turnNum: 1,
          origin: savedOrigin("live", "g1"),
        }),
      ]),
    });

    await sweepAsCaller(T0 + 3 * HOUR);

    const provisional = harness.uploadTurn.mock.calls[0][0] as {
      turnNum: number;
      buffer: { status?: string };
    };
    expect(provisional.turnNum).toBe(1);
    expect(provisional.buffer.status).toBe("incomplete");
    expect(loadState(stateFilePath).live.pending).toBeUndefined();

    vi.setSystemTime(T0 + 3 * HOUR + MINUTE);
    await runHook("stop");

    expect(harness.uploadTurn).toHaveBeenCalledTimes(1);
    const superseding = harness.captureTurnSource.mock.calls[0][0] as {
      turnNum: number;
      conversationId: string;
      buffer: { status?: string; prompt?: string };
    };
    expect(superseding).toMatchObject({ turnNum: 1, conversationId: "live" });
    expect(superseding.buffer.status).toBe("completed");
    expect(superseding.buffer.prompt).toBe("think for a long time");

    const after = loadState(stateFilePath);
    expect(after.live.turns).toEqual({});
    expect(after.live.pending).toBeUndefined();
    expect(after.live.stopFinalizedGenerations).toEqual(["g1"]);
    expect(after.live.sweepFinalizedGenerations).toBeUndefined();
  });

  it("forgets a swept turn once another idle window passes with no stop", async () => {
    seedStrandedTurn();

    await sweepAsCaller(T0 + 3 * HOUR);
    expect(loadState(stateFilePath).stranded.turns.gs.sweptAtMs).toBe(T0 + 3 * HOUR);

    await sweepAsCaller(T0 + 3 * HOUR + MINUTE);
    expect(harness.uploadTurn).toHaveBeenCalledTimes(1);
    expect(loadState(stateFilePath).stranded.turns.gs).toBeDefined();

    await sweepAsCaller(T0 + 5 * HOUR);
    expect(harness.uploadTurn).toHaveBeenCalledTimes(1);
    expect(loadState(stateFilePath).stranded.turns).toEqual({});
  });

  it("loads the tracing module only once a turn is claimed", async () => {
    saveState(stateFilePath, { live: conversation([turn("g1", T0 + 3 * HOUR)]) });

    await sweepAsCaller(T0 + 3 * HOUR);

    expect(harness.initTracing).not.toHaveBeenCalled();
  });
});
