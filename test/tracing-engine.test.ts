import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { turnRunId } from "../src/langsmith.js";
import type { UploadJobContext } from "../src/models/job-context.js";
import { saveToolForUpload, saveTurnForUpload } from "../src/tracing-engine.js";
import { loadState, T0, testConfig, tool, turn } from "./utils/state.js";

const engine = vi.hoisted(() => ({
  queueResults: [] as Array<{ status: string }>,
  recoveryReport: undefined as undefined | ((result: unknown) => void),
  reconstruct: undefined as undefined | ((job: unknown) => Promise<unknown>),
  warnings: [] as string[],
  queued: [] as Array<Record<string, unknown>>,
  captured: [] as unknown[],
  saved: new Map<string, { destinationFingerprint: string; turnEvidence: unknown }>(),
  queuedTurnsAtQueue: [] as string[][],
}));

vi.mock("@langchain/plugins-base/plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@langchain/plugins-base/plugin")>()),
  openPluginSession: (options: {
    onRecoveryReport: (result: unknown) => void;
    reconstruct: (job: unknown) => Promise<unknown>;
  }) => {
    engine.recoveryReport = options.onRecoveryReport;
    engine.reconstruct = options.reconstruct;
    return {
      sessionId: "c1",
      store: {
        read: async ({ eventId }: { eventId: string }) => engine.saved.get(eventId),
        readSettledTurn: async () => undefined,
      },
      fingerprint: "fingerprint",
      session: {
        capture: async (input: unknown) => {
          engine.captured.push(input);
          return { status: "published" };
        },
        queueReconstruction: async (input: Record<string, unknown>) => {
          engine.queued.push(input);
          engine.queuedTurnsAtQueue.push(
            Object.keys(loadState(config.stateFilePath).c1?.queued ?? {}),
          );
          return engine.queueResults.shift() ?? { status: "published" };
        },
        readSavedReconstructionWake: async () => undefined,
      },
    };
  },
}));
vi.mock("../src/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/logger.js")>()),
  warn: (message: string) => engine.warnings.push(message),
}));

interface Output {
  eventId: string;
  submission: {
    operation: string;
    run: { name?: string; end_time?: unknown };
    metadata: { base?: Record<string, unknown> };
  };
  dependencies?: Array<{ eventId: string }>;
}

let config = testConfig("/nonexistent/state.json");

const toolTurn: UploadJobContext = {
  kind: "stop",
  buffer: turn("g1", T0, {
    tracingMode: "full",
    prompt: "p",
    tools: [tool("t1", "Shell", T0 + 1000)],
  }),
  conversationId: "c1",
  turnNum: 1,
  origin: { project: "cursor" },
};

const toolOptions = { ...toolTurn, project: "cursor" };

async function build(): Promise<Output[]> {
  const input = engine.queued.at(-1)!;
  const job = { ...input, integration: "cursor", sessionId: "c1", accountFingerprint: "fp" };
  const result = (await engine.reconstruct!(job)) as { outputs: Output[] };
  return result.outputs;
}

async function saveToolEarly(fingerprint: string): Promise<string[]> {
  await saveToolForUpload(config, toolOptions, 0, () => []);
  const early = (engine.captured as Array<{ eventId: string }>).map(({ eventId }) => eventId);
  for (const eventId of early) {
    engine.saved.set(eventId, { destinationFingerprint: fingerprint, turnEvidence: {} });
  }
  engine.captured.length = 0;
  return early;
}

beforeEach(() => {
  config = testConfig(join(mkdtempSync(join(tmpdir(), "cursor-engine-")), "state.json"));
  engine.queued.length = 0;
  engine.queuedTurnsAtQueue.length = 0;
  engine.captured.length = 0;
  engine.saved.clear();
  engine.queueResults.length = 0;
  engine.warnings.length = 0;
});

describe("saving a turn for upload", () => {
  it("only queues a to-do for the uploader, and builds no runs in the hook", async () => {
    expect(await saveTurnForUpload(config, toolTurn)).toBe(true);
    expect(engine.captured).toEqual([]);
    expect(engine.queued).toHaveLength(1);
    expect(engine.queued[0].turnId).toBe(turnRunId("c1", "g1"));
    expect(engine.queuedTurnsAtQueue).toEqual([["g1"]]);
  });

  it("keeps the turn for a later retry when the store does not take its to-do", async () => {
    engine.queueResults.push({ status: "failed" });
    expect(await saveTurnForUpload(config, toolTurn)).toBe(false);
    expect(engine.warnings.join("\n")).toContain("Keeping the turn for a later retry");
  });

  it("fills the session's repo and each tool's own repo in the uploader", async () => {
    const repo = (name: string) => {
      const cwd = mkdtempSync(join(tmpdir(), `cursor-${name}-`));
      const git = (...args: string[]) => execFileSync("git", args, { cwd });
      git("init", "-q", "-b", "trunk");
      git("config", "user.name", "Repo Author");
      git("config", "user.email", "author@example.com");
      git("remote", "add", "origin", `git@github.com:acme/${name}.git`);
      git("commit", "-q", "--allow-empty", "-m", "c");
      return cwd;
    };
    const session = repo("widget");
    const other = repo("gadget");
    const tools = [tool("t1", "Read", T0 + 1000, { path: join(other, "a.ts") })];
    await saveTurnForUpload(config, {
      ...toolTurn,
      buffer: { ...toolTurn.buffer, tools },
      origin: { project: "cursor", customMetadata: { cwd: session, git_branch: "pinned" } },
    });
    const outputs = await build();
    const base = (name: string) =>
      outputs.find(({ submission }) => submission.run.name === name)!.submission.metadata.base;
    expect(base("Cursor Turn 1")).toMatchObject({
      repository_name: "acme/widget",
      git_branch: "pinned",
      ls_attribution_identifier: "Repo Author",
    });
    expect(base("Read")).toMatchObject({ repository_name: "acme/gadget" });
  });
});

describe("retrying a turn the uploader already started", () => {
  it("rebuilds the same runs even though some were saved by the attempt that died", async () => {
    await saveTurnForUpload(config, toolTurn);
    const first = (await build()).map(({ eventId }) => eventId);
    for (const eventId of first.slice(0, 2)) {
      engine.saved.set(eventId, {
        destinationFingerprint: "fingerprint",
        turnEvidence: { closureState: "authoritative" },
      });
    }
    expect((await build()).map(({ eventId }) => eventId)).toEqual(first);
  });

  it("ends the turn when the hook saved it, not when the uploader builds it", async () => {
    const savedAt = Date.now();
    await saveTurnForUpload(config, toolTurn);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(savedAt + 3_600_000);
    try {
      const [root] = await build();
      const end = root.submission.run.end_time;
      expect(typeof end === "number" ? end : Date.parse(String(end))).toBeLessThan(
        savedAt + 60_000,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("saving a turn whose tool was saved before stop", () => {
  it("updates the saved root instead of saving it again, and skips the saved tool", async () => {
    const [rootPost, toolPost] = await saveToolEarly("fingerprint");
    await saveTurnForUpload(config, toolTurn);
    const outputs = await build();
    const sent = outputs.map(({ eventId }) => eventId);
    expect(sent).toContain(rootPost.replace("post:", "patch:"));
    expect(sent).not.toContain(rootPost);
    expect(sent).not.toContain(toolPost);
    const patch = outputs.find(({ eventId }) => eventId.startsWith("patch:"));
    expect(patch?.dependencies?.map(({ eventId }) => eventId)).toEqual([rootPost]);
  });

  it("leaves a root alone once a saved copy already closed it", async () => {
    const [rootPost] = await saveToolEarly("fingerprint");
    const closed = {
      destinationFingerprint: "fingerprint",
      turnEvidence: { closureState: "authoritative" },
    };
    engine.saved.set(rootPost, closed);
    await saveTurnForUpload(config, toolTurn);
    expect((await build()).filter(({ eventId }) => eventId.startsWith("patch:"))).toEqual([]);
  });

  it("still gives the uploader a run when stop finds every run already saved", async () => {
    await saveTurnForUpload(config, toolTurn);
    for (const { eventId } of await build()) {
      engine.saved.set(eventId, {
        destinationFingerprint: "fingerprint",
        turnEvidence: { closureState: "authoritative" },
      });
    }
    await saveTurnForUpload(config, toolTurn);
    expect((await build()).map(({ eventId }) => eventId.split(":")[0])).toEqual(["patch"]);
  });

  it("puts the prompt's attachments on a root saved before stop", async () => {
    const image = { type: "image", mime_type: "image/png", base64: "QVRUQUNI" } as const;
    await saveToolForUpload(config, toolOptions, 0, () => [image]);
    expect(JSON.stringify(engine.captured[0])).toContain("QVRUQUNI");
  });

  it("leaves a later tool for stop while the turn's root belongs to another account", async () => {
    await saveToolEarly("other-account");
    const tools = [...toolTurn.buffer.tools, tool("t2", "Read", T0 + 2000)];
    const later = { ...toolOptions, buffer: { ...toolTurn.buffer, tools } };
    await saveToolForUpload(config, later, 1, () => []);
    expect(engine.captured).toEqual([]);
  });
});

describe("the background recovery report", () => {
  it.each(["partial", "failed"])("warns when older conversations are %s", async (status) => {
    await saveTurnForUpload(config, toolTurn);
    engine.recoveryReport!({ status });
    expect(engine.warnings.join("\n")).toContain("Could not upload every older conversation");
  });

  it.each(["completed", "scope-mismatch"])("stays quiet when it is %s", async (status) => {
    await saveTurnForUpload(config, toolTurn);
    engine.recoveryReport!({ status });
    expect(engine.warnings).toEqual([]);
  });
});
