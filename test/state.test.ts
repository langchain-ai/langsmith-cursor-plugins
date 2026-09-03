import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadState,
  saveState,
  atomicUpdateState,
  getConversationState,
  newTurnBuffer,
  pruneOldConversations,
} from "../src/state.js";
import type { TracingState } from "../src/types.js";

function tmpStateFile(): string {
  return join(mkdtempSync(join(tmpdir(), "ls-cursor-")), "state.json");
}

describe("getConversationState / newTurnBuffer", () => {
  it("returns an empty conversation for an unknown id", () => {
    expect(getConversationState({}, "x")).toEqual({ turns: {}, turn_count: 0, updated: "" });
  });

  it("creates an empty turn buffer", () => {
    const t = newTurnBuffer("gen1", 1000);
    expect(t).toMatchObject({ generation_id: "gen1", startMs: 1000 });
    expect(t.tools).toEqual([]);
    expect(t.subagents).toEqual([]);
  });
});

describe("loadState / saveState", () => {
  it("round-trips state and returns {} for a missing file", () => {
    const file = tmpStateFile();
    expect(loadState(file)).toEqual({});
    const state: TracingState = { c1: { turns: {}, turn_count: 2, updated: "t" } };
    saveState(file, state);
    expect(loadState(file)).toEqual(state);
  });

  it("fails closed for malformed JSON or any malformed nested entry", () => {
    const file = tmpStateFile();
    writeFileSync(file, "{not json");
    expect(loadState(file)).toMatchObject({ __langsmith_corrupt_state__: { tracing: "metadata" } });
    writeFileSync(
      file,
      JSON.stringify({
        good: { turns: {}, turn_count: 0, updated: "t" },
        bad: {
          turns: {
            generation: {
              generation_id: "generation",
              tracing_mode: "full",
              startMs: 1,
              tools: [{ name: "Read" }],
              thoughts: [],
              subagents: [],
            },
          },
          turn_count: 0,
          updated: "t",
        },
      }),
    );
    expect(loadState(file)).toMatchObject({ __langsmith_corrupt_state__: { tracing: "metadata" } });
  });

  it("discards all buffers on a corrupt sentinel and retains only sticky metadata policies", () => {
    const file = tmpStateFile();
    writeFileSync(
      file,
      JSON.stringify({
        full: {
          turns: {
            generation: {
              generation_id: "generation",
              tracing_mode: "full",
              startMs: 1,
              prompt: "secret prompt",
              finalText: "secret answer",
              tools: [],
              thoughts: [{ text: "secret thought" }],
              subagents: [],
            },
          },
          turn_count: 2,
          updated: "t",
        },
        muted: { turns: {}, turn_count: 3, updated: "u", tracing: "metadata" },
        __langsmith_corrupt_state__: { tracing: "metadata" },
      }),
    );

    const state = loadState(file);
    expect(state).toEqual({
      muted: { turns: {}, turn_count: 3, updated: "u", tracing: "metadata" },
      __langsmith_corrupt_state__: { turns: {}, turn_count: 0, updated: "", tracing: "metadata" },
    });
    expect(JSON.stringify(state)).not.toContain("secret");
  });

  it("writes state files with private permissions", () => {
    const file = tmpStateFile();
    saveState(file, { thread: { turns: {}, turn_count: 0, updated: "t" } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("atomicUpdateState", () => {
  it("serializes concurrent updates without losing writes", async () => {
    const file = tmpStateFile();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        atomicUpdateState(file, (s) => ({
          ...s,
          [`c${i}`]: { turns: {}, turn_count: i, updated: "t" },
        })),
      ),
    );
    const state = loadState(file);
    expect(Object.keys(state).length).toBe(10);
  });

  it("recovers an old malformed legacy lock and keeps the lock private", async () => {
    const file = tmpStateFile();
    const lock = `${file}.lock`;
    writeFileSync(lock, "", { mode: 0o600 });
    const old = new Date(Date.now() - 20_000);
    utimesSync(lock, old, old);

    await atomicUpdateState(file, (state) => ({
      ...state,
      recovered: { turns: {}, turn_count: 0, updated: "t" },
    }));

    expect(loadState(file).recovered).toBeDefined();
    expect(existsSync(lock)).toBe(false);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("does not steal a fresh create-before-write lock", async () => {
    const file = tmpStateFile();
    const lock = `${file}.lock`;
    writeFileSync(lock, "", { mode: 0o600 });

    const update = atomicUpdateState(file, (state) => state);
    await expect(update).rejects.toThrow("Timed out acquiring LangSmith state lock");
    expect(existsSync(lock)).toBe(true);
    expect(statSync(lock).mode & 0o777).toBe(0o600);
  }, 7_000);
});

describe("pruneOldConversations", () => {
  it("drops conversations older than 24h, keeps recent ones", () => {
    const now = Date.parse("2026-06-09T12:00:00Z");
    const state: TracingState = {
      fresh: { turns: {}, turn_count: 1, updated: "2026-06-09T11:00:00Z" },
      stale: { turns: {}, turn_count: 1, updated: "2026-06-07T11:00:00Z" },
      empty: { turns: {}, turn_count: 1, updated: "" },
    };
    const pruned = pruneOldConversations(state, now);
    expect(Object.keys(pruned)).toEqual(["fresh"]);
  });
});
