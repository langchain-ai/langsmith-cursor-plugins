import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { testConfig } from "./utils/state.js";

const harness = vi.hoisted(() => ({
  spawn: vi.fn(),
  unref: vi.fn(),
  loadConfig: vi.fn(),
  reconstructCursorTurn: vi.fn(),
  initTracing: vi.fn(),
  runSweep: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: harness.spawn }));
vi.mock("../src/config.js", () => ({ loadConfig: harness.loadConfig }));
vi.mock("../src/langsmith.js", () => ({
  initTracing: harness.initTracing,
  reconstructCursorTurn: harness.reconstructCursorTurn,
}));
vi.mock("../src/sweep.js", () => ({ runSweep: harness.runSweep }));

afterEach(() => {
  vi.restoreAllMocks();
});

it("starts a detached worker with the saved sweep scope", async () => {
  const originalEntry = process.argv[1];
  harness.spawn.mockImplementation(() => ({ pid: 123, unref: harness.unref }) as never);
  const { launchCursorSweepWorker } = await import("../src/tracing-engine.js");
  const config = {
    ...testConfig("/state/state.json"),
    customMetadata: { cwd: "/caller/workspace" },
  };
  const input = {
    conversation_id: "caller-conversation",
    generation_id: "caller-turn",
    session_id: "caller-session",
    model: "default",
    hook_event_name: "sessionStart",
    workspace_roots: ["/original/workspace"],
  };
  process.argv[1] = "/plugin/hooks/session-start.js";

  try {
    expect(launchCursorSweepWorker(config, input, true)).toBe(123);
  } finally {
    process.argv[1] = originalEntry;
  }

  expect(harness.spawn).toHaveBeenCalledWith(
    process.execPath,
    [
      join("/plugin/hooks", "stop.js"),
      "--cursor-engine-worker",
      "caller-session",
      "/original/workspace",
      "cursor",
      "sweep",
      "caller-conversation",
      "prune",
    ],
    expect.objectContaining({ detached: true, stdio: "ignore" }),
  );
  expect(harness.unref).toHaveBeenCalledOnce();
});

it("runs state pruning only inside a sweep worker", async () => {
  const config = testConfig("/state/state.json");
  harness.loadConfig.mockReturnValue(config);
  harness.runSweep.mockReset();
  const { runCursorEngineWorker } = await import("../src/tracing-engine.js");

  await runCursorEngineWorker({
    sessionId: "worker-session",
    cwd: "/workspace",
    project: "cursor",
    mode: "sweep",
    callerConversationId: "caller-conversation",
    pruneState: true,
  });

  expect(harness.runSweep).toHaveBeenCalledOnce();
  const options = harness.runSweep.mock.calls[0]![0] as {
    input: { conversation_id: string };
    apply: (state: Record<string, unknown>) => Record<string, unknown>;
  };
  expect(options.input.conversation_id).toBe("caller-conversation");
  expect(
    options.apply({
      stale: { turns: {}, turn_count: 0, updated: "2000-01-01T00:00:00.000Z" },
    }),
  ).toEqual({});
  expect(harness.initTracing).not.toHaveBeenCalled();
});
