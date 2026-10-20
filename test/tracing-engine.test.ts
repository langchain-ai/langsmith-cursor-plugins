import { beforeEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({
  results: [] as Array<{ status: string }>,
  recoveryReport: undefined as undefined | ((result: unknown) => void),
  warnings: [] as string[],
  debugs: [] as string[],
}));

vi.mock("@langchain/plugins-base/plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@langchain/plugins-base/plugin")>()),
  openPluginSession: (options: { onRecoveryReport: (result: unknown) => void }) => {
    engine.recoveryReport = options.onRecoveryReport;
    return {
      sessionId: "c1",
      store: {},
      fingerprint: "fingerprint",
      session: { capture: async () => engine.results.shift() ?? { status: "published" } },
    };
  },
}));
vi.mock("../src/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/logger.js")>()),
  warn: (message: string) => engine.warnings.push(message),
  debug: (message: string) => engine.debugs.push(message),
}));

import { saveTurnForUpload } from "../src/tracing-engine.js";
import { T0, testConfig, turn } from "./utils/state.js";

function save() {
  return saveTurnForUpload(testConfig("/nonexistent/state.json"), {
    buffer: turn("g1", T0, { tracingMode: "full", prompt: "p" }),
    conversationId: "c1",
    turnNum: 1,
    project: "cursor",
  });
}

beforeEach(() => {
  engine.results.length = 0;
  engine.warnings.length = 0;
  engine.debugs.length = 0;
});

describe("saving a turn for upload", () => {
  it("counts a run the store already holds as saved, and says so", async () => {
    engine.results.push(...Array.from({ length: 8 }, () => ({ status: "conflict" })));
    expect(await save()).toBe(true);
    expect(engine.debugs.some((message) => message.includes("was already saved"))).toBe(true);
    expect(engine.warnings).toEqual([]);
  });

  it("keeps the turn for a later retry when the store does not take a run", async () => {
    engine.results.push({ status: "published" }, { status: "failed" });
    expect(await save()).toBe(false);
    expect(engine.warnings.join("\n")).toContain("Keeping the turn for a later retry");
  });
});

describe("the background recovery report", () => {
  it.each(["partial", "failed"])("warns when older conversations are %s", async (status) => {
    await save();
    engine.recoveryReport!({ status });
    expect(engine.warnings.join("\n")).toContain("Could not upload every older conversation");
  });

  it.each(["completed", "scope-mismatch"])("stays quiet when it is %s", async (status) => {
    await save();
    engine.recoveryReport!({ status });
    expect(engine.warnings).toEqual([]);
  });
});
