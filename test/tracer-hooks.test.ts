import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookNote } from "@langchain/plugins-base/tracer";

vi.mock("../src/utils/stdin.js", () => ({ readStdin: vi.fn() }));
vi.mock("@langchain/plugins-base/plugin", async (original) => ({
  ...(await original<typeof import("@langchain/plugins-base/plugin")>()),
  launchDetachedWorker: vi.fn(async () => 1),
}));

import { launchDetachedWorker } from "@langchain/plugins-base/plugin";
import { NOTE_RUNNERS } from "../src/tracer-hooks.js";
import { setThreadTracingMode } from "../src/tracing-policy.js";
import { readStdin } from "../src/utils/stdin.js";

let dir: string;
const notesFile = () => join(dir, "langsmith_plugins_base", "notes.jsonl");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tracer hooks "));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.stubEnv("LANGSMITH_CURSOR_STATE_FILE", join(dir, "langsmith_state.json"));
  vi.stubEnv("LANGSMITH_CURSOR_PRIVACY_FILE", join(dir, "privacy.json"));
  vi.stubEnv("LANGSMITH_CURSOR_LOG_FILE", join(dir, "hook.log"));
  vi.stubEnv("TRACE_TO_LANGSMITH", "true");
  vi.stubEnv("LANGSMITH_CURSOR_API_KEY", "test-key");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function runHook(name: string, payload: Record<string, unknown>): Promise<HookNote[]> {
  vi.mocked(readStdin).mockResolvedValue({ workspace_roots: [dir], model: "m", ...payload });
  await NOTE_RUNNERS[name]();
  if (!existsSync(notesFile())) return [];
  return readFileSync(notesFile(), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as HookNote);
}

describe("Cursor hook notes", () => {
  it("files a subagent's own tool calls under the parent's workspace session", async () => {
    await runHook("before-submit-prompt", {
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: "parent",
      generation_id: "g1",
      prompt: "hi",
    });
    const notes = await runHook("post-tool-use", {
      hook_event_name: "postToolUse",
      conversation_id: "child",
      generation_id: "g2",
      tool_use_id: "t1",
    });
    expect(notes.map((note) => [note.event, note.sessionId])).toEqual([
      ["beforeSubmitPrompt", dir],
      ["postToolUse", dir],
    ]);
  });

  it("carries a muted thread's mode and records an off launch without starting the worker", async () => {
    await setThreadTracingMode(join(dir, "privacy.json"), "c1", "metadata");
    const prompt = { hook_event_name: "beforeSubmitPrompt", conversation_id: "c1", prompt: "hi" };
    const [muted] = await runHook("before-submit-prompt", { ...prompt, generation_id: "g1" });
    expect(muted.tracingMode).toBe("metadata");
    expect(launchDetachedWorker).toHaveBeenCalledTimes(1);

    vi.stubEnv("TRACE_TO_LANGSMITH", "false");
    const [, off] = await runHook("before-submit-prompt", { ...prompt, generation_id: "g2" });
    const stop = { hook_event_name: "stop", conversation_id: "c1", generation_id: "g2" };
    const [, , offStop] = await runHook("stop", stop);
    expect([off.tracingMode, offStop.tracingMode]).toEqual(["off", "off"]);
    expect(JSON.stringify(off)).not.toContain('"hi"');
    expect(launchDetachedWorker).toHaveBeenCalledTimes(1);
  });

  it("starts the worker for off launches once their notes pass a megabyte", async () => {
    vi.stubEnv("TRACE_TO_LANGSMITH", "false");
    const stop = { hook_event_name: "stop", conversation_id: "c1", generation_id: "g1" };
    await runHook("stop", stop);
    expect(launchDetachedWorker).not.toHaveBeenCalled();
    appendFileSync(notesFile(), `${JSON.stringify({ padding: "x".repeat(1024 * 1024) })}\n`);
    await runHook("stop", stop);
    expect(launchDetachedWorker).toHaveBeenCalledTimes(1);
  });
});
