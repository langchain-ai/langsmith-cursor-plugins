import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runSweep } from "../src/sweep.js";
import type { Config } from "../src/models/config.js";
import {
  HOUR,
  MINUTE,
  T0,
  conversation,
  loadState,
  saveState,
  testConfig,
  turn,
} from "./utils/state.js";

const harness = vi.hoisted(() => ({
  input: {} as Record<string, unknown>,
  config: undefined as Config | undefined,
  uploadError: undefined as Error | undefined,
  uploadAccepted: true,
  recoverConversations: vi.fn(async () => {}),
  saveToolForUpload: vi.fn(async (..._args: unknown[]) => {}),
  resolveTurnAttachments: vi.fn(() => []),
  saveTurnForUpload: vi.fn(async () => {
    if (harness.uploadError) throw harness.uploadError;
    return harness.uploadAccepted;
  }),
}));

vi.mock("../src/utils/stdin.js", () => ({ readStdin: async () => harness.input }));
vi.mock("../src/utils/hook-init.js", () => ({ initHook: () => harness.config ?? null }));
vi.mock("../src/conversation-steps.js", () => ({ resolveTurnSteps: () => undefined }));
vi.mock("../src/attachments.js", () => ({
  resolveTurnAttachments: harness.resolveTurnAttachments,
}));
vi.mock("../src/tracing-engine.js", () => ({
  recoverConversations: harness.recoverConversations,
  saveTurnForUpload: harness.saveTurnForUpload,
  saveToolForUpload: harness.saveToolForUpload,
}));

const HOOKS = {
  stop: () => import("../src/hooks/stop.js"),
  "session-start": () => import("../src/hooks/session-start.js"),
  "post-tool-use": () => import("../src/hooks/post-tool-use.js"),
};

async function runHook(name: keyof typeof HOOKS): Promise<void> {
  vi.resetModules();
  const hook = await HOOKS[name]();
  await hook.run();
}

describe("hook wiring against the on-disk state file", () => {
  let dir: string;
  let stateFilePath: string;
  const savedPolicy = process.env.LANGSMITH_CURSOR_PRIVACY_FILE;
  const savedLogFile = process.env.LANGSMITH_CURSOR_LOG_FILE;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hook-wiring-"));
    stateFilePath = join(dir, "langsmith_state.json");
    process.env.LANGSMITH_CURSOR_PRIVACY_FILE = join(dir, "absent-privacy.json");
    process.env.LANGSMITH_CURSOR_LOG_FILE = join(dir, "hook.log");
    harness.uploadError = undefined;
    harness.uploadAccepted = true;
    harness.saveTurnForUpload.mockClear();
    harness.recoverConversations.mockClear();
    harness.saveToolForUpload.mockClear();
    harness.resolveTurnAttachments.mockClear();
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
    if (savedPolicy === undefined) delete process.env.LANGSMITH_CURSOR_PRIVACY_FILE;
    else process.env.LANGSMITH_CURSOR_PRIVACY_FILE = savedPolicy;
    if (savedLogFile === undefined) delete process.env.LANGSMITH_CURSOR_LOG_FILE;
    else process.env.LANGSMITH_CURSOR_LOG_FILE = savedLogFile;
    rmSync(dir, { recursive: true, force: true });
  });

  function seedLiveTurn(): void {
    saveState(stateFilePath, {
      live: conversation([turn("g1", T0, { tracingMode: "full", prompt: "trace me" })]),
    });
    vi.setSystemTime(T0 + MINUTE);
  }

  function seedStrandedTurn(): void {
    saveState(stateFilePath, { stranded: conversation([turn("gs", T0, { tracingMode: "full" })]) });
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

  it("clears its own pending upload when stop uploads the turn", async () => {
    seedLiveTurn();

    await runHook("stop");

    expect(harness.saveTurnForUpload).toHaveBeenCalledTimes(1);
    const after = loadState(stateFilePath);
    expect(after.live).toMatchObject({ turns: {}, turn_count: 1 });
    expect(after.live.pending).toBeUndefined();
  });

  it("holds the turn pending when stop cannot upload it", async () => {
    seedLiveTurn();
    harness.uploadError = new Error("upload rejected");

    await runHook("stop");

    const after = loadState(stateFilePath);
    expect(after.live.pending!.g1.attempts).toBe(1);
    expect(after.live.pending!.g1.buffer.prompt).toBe("trace me");
  });

  it("holds the turn pending when the server refuses the upload", async () => {
    seedLiveTurn();
    harness.uploadAccepted = false;

    await runHook("stop");

    const after = loadState(stateFilePath);
    expect(after.live.pending!.g1.attempts).toBe(1);
    expect(after.live.pending!.g1.buffer.prompt).toBe("trace me");
  });

  it("recovers another thread's stranded turn from the stop hook", async () => {
    saveState(stateFilePath, {
      live: conversation([turn("g1", T0 + 3 * HOUR, { tracingMode: "full" })]),
      stranded: conversation([turn("gs", T0, { tracingMode: "full" })]),
    });

    await runHook("stop");

    expect(harness.saveTurnForUpload).toHaveBeenCalledTimes(2);
    const after = loadState(stateFilePath);
    expect(after.stranded).toMatchObject({ turns: {}, turn_count: 1 });
    expect(after.stranded.pending).toBeUndefined();
  });

  it("sweeps from the session-start hook", async () => {
    seedStrandedTurn();
    harness.input = {
      hook_event_name: "sessionStart",
      conversation_id: "fresh",
      generation_id: "gf",
      model: "default",
    };

    await runHook("session-start");

    expect(harness.saveTurnForUpload).toHaveBeenCalledTimes(1);
    expect(loadState(stateFilePath).stranded.turn_count).toBe(1);
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
    expect(harness.saveTurnForUpload).not.toHaveBeenCalled();
  });

  it.each([
    ["a turn its prompt opened", { tracingMode: "full", turnNum: 1 }, {}, 1],
    ["a subagent's own conversation", { turnNum: 1 }, {}, 0],
    ["a turn with no turn number", { tracingMode: "full" }, {}, 0],
    ["a turn the sweep already saved", { tracingMode: "full", turnNum: 1 }, { sweep: true }, 0],
  ] as const)("saves the tool run early only for %s", async (_, buffer, conv, calls) => {
    const swept = "sweep" in conv ? { sweepFinalizedGenerations: ["g1"] } : {};
    saveState(stateFilePath, { live: conversation([turn("g1", T0, buffer)], swept) });
    harness.input = {
      hook_event_name: "postToolUse",
      conversation_id: "live",
      generation_id: "g1",
      model: "default",
      tool_name: "Read",
      tool_use_id: "t1",
      tool_input: {},
      tool_output: "{}",
    };

    await runHook("post-tool-use");

    expect(harness.saveToolForUpload).toHaveBeenCalledTimes(calls);
  });

  it.each([
    ["full", 1],
    ["metadata", 0],
  ] as const)("loads attachments for an early %s root only in full mode", async (mode, loads) => {
    harness.config = { ...harness.config!, attachmentsEnabled: true };
    saveState(stateFilePath, {
      live: conversation([turn("g1", T0, { tracingMode: mode, turnNum: 1 })]),
    });
    harness.input = {
      hook_event_name: "postToolUse",
      conversation_id: "live",
      generation_id: "g1",
      model: "default",
      tool_name: "Read",
      tool_use_id: "t1",
      tool_input: {},
      tool_output: "{}",
    };

    await runHook("post-tool-use");
    (harness.saveToolForUpload.mock.calls[0][3] as () => unknown)();

    expect(harness.resolveTurnAttachments).toHaveBeenCalledTimes(loads);
  });

  it("keeps a failed sweep upload pending for a later retry", async () => {
    saveState(stateFilePath, {
      stranded: conversation([], {
        turn_count: 1,
        pending: {
          gs: {
            buffer: turn("gs", T0, { tracingMode: "full" }),
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
        turn("g1", T0, { tracingMode: "full", prompt: "think for a long time", turnNum: 1 }),
      ]),
    });

    await sweepAsCaller(T0 + 3 * HOUR);

    const provisional = harness.saveTurnForUpload.mock.calls[0][1] as {
      turnNum: number;
      buffer: { status?: string };
    };
    expect(provisional.turnNum).toBe(1);
    expect(provisional.buffer.status).toBe("incomplete");
    expect(loadState(stateFilePath).live.pending).toBeUndefined();

    vi.setSystemTime(T0 + 3 * HOUR + MINUTE);
    await runHook("stop");

    expect(harness.saveTurnForUpload).toHaveBeenCalledTimes(2);
    const superseding = harness.saveTurnForUpload.mock.calls[1][1] as {
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
    expect(harness.saveTurnForUpload).toHaveBeenCalledTimes(1);
    expect(loadState(stateFilePath).stranded.turns.gs).toBeDefined();

    await sweepAsCaller(T0 + 5 * HOUR);
    expect(harness.saveTurnForUpload).toHaveBeenCalledTimes(1);
    expect(loadState(stateFilePath).stranded.turns).toEqual({});
  });

  it("restarts the uploader of an older conversation whose saved traces are waiting", async () => {
    await sweepAsCaller(T0);
    expect(harness.recoverConversations).toHaveBeenCalledWith(
      harness.config,
      "caller",
      harness.config!.sweepIdleMinutes * MINUTE,
    );
  });
});
