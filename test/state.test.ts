import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const warnings = vi.hoisted(() => [] as string[]);

vi.mock("../src/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/logger.js")>()),
  warn: (message: string) => warnings.push(message),
}));

import {
  atomicUpdateState,
  getConversationState,
  newTurnBuffer,
  nextTurnNum,
  pruneOldConversations,
  readState,
} from "../src/state.js";
import type { TracingState } from "../src/models/types.js";
import { loadState } from "./utils/state.js";

function tmpStateFile(): string {
  return join(mkdtempSync(join(tmpdir(), "ls-cursor-")), "state.json");
}

describe("getConversationState / newTurnBuffer", () => {
  it("returns an empty conversation for an unknown id", () => {
    expect(getConversationState({}, "x")).toEqual({ turns: {}, turn_count: 0, updated: "" });
  });

  it("creates an empty turn buffer", () => {
    const t = newTurnBuffer("gen1", 1000, 2);
    expect(t).toMatchObject({ generation_id: "gen1", startMs: 1000, turnNum: 2 });
    expect(t.tools).toEqual([]);
    expect(t.subagents).toEqual([]);
  });

  it("issues turn numbers in order and seeds from a pre-upgrade thread", () => {
    const fresh = { turns: {}, turn_count: 0, updated: "" };
    expect([nextTurnNum(fresh), nextTurnNum(fresh)]).toEqual([1, 2]);

    const upgraded = { turns: {}, turn_count: 5, updated: "" };
    expect(nextTurnNum(upgraded)).toBe(6);
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
    expect(Object.keys(readState(file)).length).toBe(10);
  });

  it("treats a state file that holds something other than an object as empty", async () => {
    const file = tmpStateFile();
    writeFileSync(file, "[]");
    await atomicUpdateState(file, (s) => {
      expect(s).toEqual({});
      return { ...s, a: { turns: {}, turn_count: 1, updated: "t" } };
    });
    expect(Object.keys(loadState(file))).toEqual(["a"]);
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
