import { beforeEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({
  results: [] as Array<{ status: string }>,
  recoveryReport: undefined as undefined | ((result: unknown) => void),
  warnings: [] as string[],
  debugs: [] as string[],
  captured: [] as Array<{
    eventId: string;
    submission: { operation: string };
    dependencies?: Array<{ eventId: string }>;
  }>,
  saved: new Map<string, { destinationFingerprint: string; turnEvidence: unknown }>(),
}));

vi.mock("@langchain/plugins-base/plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@langchain/plugins-base/plugin")>()),
  openPluginSession: (options: { onRecoveryReport: (result: unknown) => void }) => {
    engine.recoveryReport = options.onRecoveryReport;
    return {
      sessionId: "c1",
      store: {
        read: async ({ eventId }: { eventId: string }) => engine.saved.get(eventId),
        readSettledTurn: async () => undefined,
      },
      fingerprint: "fingerprint",
      session: {
        capture: async (input: (typeof engine.captured)[number]) => {
          engine.captured.push(input);
          return engine.results.shift() ?? { status: "published" };
        },
      },
    };
  },
}));
vi.mock("../src/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/logger.js")>()),
  warn: (message: string) => engine.warnings.push(message),
  debug: (message: string) => engine.debugs.push(message),
}));

import { saveToolForUpload, saveTurnForUpload } from "../src/tracing-engine.js";
import { T0, testConfig, tool, turn } from "./utils/state.js";

function save() {
  return saveTurnForUpload(testConfig("/nonexistent/state.json"), {
    buffer: turn("g1", T0, { tracingMode: "full", prompt: "p" }),
    conversationId: "c1",
    turnNum: 1,
    project: "cursor",
  });
}

const toolTurn = {
  buffer: turn("g1", T0, {
    tracingMode: "full",
    prompt: "p",
    tools: [tool("t1", "Shell", T0 + 1000)],
  }),
  conversationId: "c1",
  turnNum: 1,
  project: "cursor",
};

async function saveToolEarly(fingerprint: string) {
  await saveToolForUpload(testConfig("/nonexistent/state.json"), toolTurn, 0, () => []);
  for (const { eventId } of engine.captured) {
    engine.saved.set(eventId, { destinationFingerprint: fingerprint, turnEvidence: {} });
  }
  const early = engine.captured.map(({ eventId }) => eventId);
  engine.captured.length = 0;
  return early;
}

beforeEach(() => {
  engine.captured.length = 0;
  engine.saved.clear();
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

describe("saving a turn whose tool was saved before stop", () => {
  it("updates the saved root instead of saving it again, and skips the saved tool", async () => {
    const [rootPost, toolPost] = await saveToolEarly("fingerprint");
    expect(await saveTurnForUpload(testConfig("/nonexistent/state.json"), toolTurn)).toBe(true);
    const sent = engine.captured.map(({ eventId }) => eventId);
    expect(sent).toContain(rootPost.replace("post:", "patch:"));
    expect(sent).not.toContain(rootPost);
    expect(sent).not.toContain(toolPost);
  });

  it("updates the root when a tool hook saved it while stop was saving it", async () => {
    engine.results.push({ status: "conflict" });
    expect(await saveTurnForUpload(testConfig("/nonexistent/state.json"), toolTurn)).toBe(true);
    const patch = engine.captured.find(({ eventId }) => eventId.startsWith("patch:"));
    expect(patch?.dependencies?.map(({ eventId }) => eventId)).toEqual([
      engine.captured[0].eventId,
    ]);
  });

  it("leaves a root alone once a saved copy already closed it", async () => {
    const [rootPost] = await saveToolEarly("fingerprint");
    const closed = {
      destinationFingerprint: "fingerprint",
      turnEvidence: { closureState: "authoritative" },
    };
    engine.saved.set(rootPost, closed);
    expect(await saveTurnForUpload(testConfig("/nonexistent/state.json"), toolTurn)).toBe(true);
    expect(engine.captured.filter(({ eventId }) => eventId.startsWith("patch:"))).toEqual([]);
  });

  it("puts the prompt's attachments on a root saved before stop", async () => {
    const image = { type: "image", mime_type: "image/png", base64: "QVRUQUNI" } as const;
    await saveToolForUpload(testConfig("/nonexistent/state.json"), toolTurn, 0, () => [image]);
    expect(JSON.stringify(engine.captured[0].submission)).toContain("QVRUQUNI");
  });

  it("leaves a later tool for stop while the turn's root belongs to another account", async () => {
    await saveToolEarly("other-account");
    const tools = [...toolTurn.buffer.tools, tool("t2", "Read", T0 + 2000)];
    const later = { ...toolTurn, buffer: { ...toolTurn.buffer, tools } };
    await saveToolForUpload(testConfig("/nonexistent/state.json"), later, 1, () => []);
    expect(engine.captured).toEqual([]);
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
