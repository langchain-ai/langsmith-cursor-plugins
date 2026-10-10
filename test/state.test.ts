import { beforeEach, describe, it, expect, vi } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { tryAcquireFileLock } from "@langchain/plugins-base/storage";

const stateLockMocks = vi.hoisted(() => ({
  failRelease: false,
  warnings: [] as string[],
}));

vi.mock("@langchain/plugins-base/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@langchain/plugins-base/storage")>();
  return {
    ...actual,
    acquireCompatibleDirectoryFileLock: async (
      filePath: Parameters<typeof actual.acquireCompatibleDirectoryFileLock>[0],
      options: Parameters<typeof actual.acquireCompatibleDirectoryFileLock>[1],
    ) => {
      const lock = await actual.acquireCompatibleDirectoryFileLock(filePath, options);
      return {
        release: async () => {
          await lock.release();
          if (stateLockMocks.failRelease) throw new Error("state lock release failed");
        },
      };
    },
  };
});

vi.mock("../src/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/logger.js")>()),
  warn: (message: string) => stateLockMocks.warnings.push(message),
}));

import {
  loadState,
  saveState,
  atomicUpdateState,
  getConversationState,
  newTurnBuffer,
  nextTurnNum,
  pruneOldConversations,
} from "../src/state.js";
import type { TracingState } from "../src/types.js";

beforeEach(() => {
  stateLockMocks.failRelease = false;
  stateLockMocks.warnings.length = 0;
});

function tmpStateFile(): string {
  return join(mkdtempSync(join(tmpdir(), "ls-cursor-")), "state.json");
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for hook process startup");
    await delay(5);
  }
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

  it("times out with guidance while a prior hook holds the state directory", async () => {
    const file = tmpStateFile();
    const lockPath = `${file}.lock`;
    mkdirSync(lockPath, { mode: 0o700 });
    let mutationStarted = false;
    const start = performance.now();
    try {
      await expect(
        atomicUpdateState(file, (state) => {
          mutationStarted = true;
          return state;
        }),
      ).rejects.toThrow(
        "Timed out waiting for turn-state lock; confirm no writer is running before removing it",
      );
    } finally {
      rmdirSync(lockPath);
    }
    expect(performance.now() - start).toBeGreaterThanOrEqual(2_000);
    expect(mutationStarted).toBe(false);
  });

  it("serializes state updates against a different hook process", async () => {
    const file = tmpStateFile();
    const started = `${file}.child-started`;
    const entered = `${file}.child-entered`;
    const moduleUrl = new URL("../src/state.ts", import.meta.url).href;
    const childSource = [
      'import { writeFileSync } from "node:fs";',
      `const { atomicUpdateState } = await import(${JSON.stringify(moduleUrl)});`,
      `const [file, started, entered] = ${JSON.stringify([file, started, entered])};`,
      'writeFileSync(started, "started");',
      "await new Promise((resolve) => setTimeout(resolve, 50));",
      "await atomicUpdateState(file, (state) => {",
      '  writeFileSync(entered, "entered");',
      '  return { ...state, child: { turns: {}, turn_count: 1, updated: "t" } };',
      "});",
    ].join("\n");
    const lock = await tryAcquireFileLock(file);
    if (!lock) throw new Error("Could not acquire the shared test lock");
    const allowed = new Set(["path", "pathext", "systemroot", "windir", "comspec"]);
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())),
      ),
      USERPROFILE: dirname(file),
      TMP: dirname(file),
      TEMP: dirname(file),
      HOME: dirname(file),
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: dirname(file),
    };
    const update = promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", childSource],
      { cwd: process.cwd(), env, timeout: 8_000 },
    ).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      await waitForFile(started);
      await delay(250);
      expect(existsSync(entered)).toBe(false);
    } finally {
      await lock.release();
    }
    const result = await update;
    if ("error" in result) throw result.error;
    expect(existsSync(entered)).toBe(true);
    expect(loadState(file)).toHaveProperty("child");
  });

  it("preserves filesystem errors from state-lock acquisition", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ls-cursor-"));
    const blocker = join(directory, "not-a-directory");
    writeFileSync(blocker, "file");
    await expect(
      atomicUpdateState(join(blocker, "state.json"), (state) => state),
    ).rejects.toMatchObject({
      code: "EEXIST",
    });
  });

  it("keeps a mutation error when shared lock cleanup also fails", async () => {
    stateLockMocks.failRelease = true;
    const failure = new Error("state mutation failed");
    await expect(
      atomicUpdateState(tmpStateFile(), () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(stateLockMocks.warnings).toEqual([
      "Turn-state lock cleanup failed; confirm no writer is running before removing it",
    ]);
  });

  it("warns but keeps a state update after shared lock cleanup fails", async () => {
    stateLockMocks.failRelease = true;
    const file = tmpStateFile();
    await expect(
      atomicUpdateState(file, (state) => ({
        ...state,
        committed: { turns: {}, turn_count: 1, updated: "t" },
      })),
    ).resolves.toBeUndefined();
    expect(loadState(file)).toHaveProperty("committed");
    expect(stateLockMocks.warnings).toEqual([
      "Turn-state lock cleanup failed; confirm no writer is running before removing it",
    ]);
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
