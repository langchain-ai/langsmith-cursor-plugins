import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
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

  it("returns {} for malformed JSON", () => {
    const file = tmpStateFile();
    writeFileSync(file, "{not json");
    expect(loadState(file)).toEqual({});
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
