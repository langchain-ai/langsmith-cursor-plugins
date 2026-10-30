import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { turnRunId } from "../src/langsmith.js";
import type { UploadJobContext } from "../src/models/job-context.js";
import { saveToolForUpload, saveTurnForUpload } from "../src/tracing-engine.js";
import { conversation, loadState, saveState, T0, testConfig, tool, turn } from "./utils/state.js";

const engine = vi.hoisted(() => ({
  queueResults: [] as Array<{ status: string }>,
  recoveryReport: undefined as undefined | ((result: unknown) => void),
  reconstruct: undefined as undefined | ((job: unknown) => Promise<unknown>),
  warnings: [] as string[],
  queued: [] as Array<Record<string, unknown>>,
  captured: [] as unknown[],
  saved: new Map<string, { destinationFingerprint: string; turnEvidence: unknown }>(),
  queuedTurnsAtQueue: [] as string[][],
  attachments: [] as unknown[],
  attachmentLoads: 0,
  currentWriter: undefined as undefined | (() => unknown),
}));

vi.mock("@langchain/plugins-base/plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@langchain/plugins-base/plugin")>()),
  openPluginSession: (options: {
    onRecoveryReport: (result: unknown) => void;
    reconstruct: (job: unknown) => Promise<unknown>;
    currentWriter: () => unknown;
  }) => {
    engine.currentWriter = options.currentWriter;
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
vi.mock("../src/attachments.js", () => ({
  resolveTurnAttachments: () => {
    engine.attachmentLoads += 1;
    return engine.attachments;
  },
}));

interface Output {
  eventId: string;
  submission: {
    operation: string;
    privacyMode?: string;
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

const toolSave: UploadJobContext = { ...toolTurn, kind: "tool", toolIndex: 0 };

async function build(): Promise<Output[]> {
  const input = engine.queued.at(-1)!;
  const job = { ...input, integration: "cursor", sessionId: "c1", accountFingerprint: "fp" };
  const result = (await engine.reconstruct!(job)) as { outputs: Output[] };
  return result.outputs;
}

async function saveTool(context: UploadJobContext): Promise<void> {
  saveState(config.stateFilePath, { c1: conversation([context.buffer]) });
  await saveToolForUpload(config, context);
}

async function saveToolEarly(fingerprint: string): Promise<string[]> {
  await saveTool(toolSave);
  const early = (await build()).map(({ eventId }) => eventId);
  for (const eventId of early) {
    engine.saved.set(eventId, { destinationFingerprint: fingerprint, turnEvidence: {} });
  }
  return early;
}

function repo(name: string): string {
  const cwd = mkdtempSync(join(tmpdir(), `cursor-${name}-`));
  const git = (...args: string[]) => execFileSync("git", args, { cwd });
  git("init", "-q", "-b", "trunk");
  git("config", "user.name", "Repo Author");
  git("config", "user.email", "author@example.com");
  git("remote", "add", "origin", `git@github.com:acme/${name}.git`);
  git("commit", "-q", "--allow-empty", "-m", "c");
  return cwd;
}

async function buildRuns(buffer: UploadJobContext["buffer"], cwd: string): Promise<Output[]> {
  await saveTurnForUpload(config, {
    ...toolTurn,
    buffer,
    origin: { project: "cursor", customMetadata: { cwd } },
  });
  return build();
}

function baseOf(outputs: Output[], name: string): Record<string, unknown> | undefined {
  return outputs.find(({ submission }) => submission.run.name === name)!.submission.metadata.base;
}

beforeEach(() => {
  config = testConfig(join(mkdtempSync(join(tmpdir(), "cursor-engine-")), "state.json"));
  engine.queued.length = 0;
  engine.queuedTurnsAtQueue.length = 0;
  engine.captured.length = 0;
  engine.saved.clear();
  engine.queueResults.length = 0;
  engine.warnings.length = 0;
  engine.attachments = [];
  engine.attachmentLoads = 0;
});

describe("saving a turn for upload", () => {
  it("only queues a to-do for the uploader, and builds no runs in the hook", async () => {
    expect(await saveTurnForUpload(config, toolTurn)).toBe(true);
    expect(engine.captured).toEqual([]);
    expect(engine.queued).toHaveLength(1);
    expect(engine.queued[0].turnId).toBe(turnRunId("c1", "g1"));
    expect(engine.queuedTurnsAtQueue).toEqual([["g1"]]);
  });

  it("uploads a full turn muted once the managed file locks muting on", async () => {
    await saveTurnForUpload({ ...config, defaultMuted: true, locked: ["defaultMuted"] }, toolTurn);
    const modes = (await build()).map(({ submission }) => submission.privacyMode);
    expect(modes.length).toBeGreaterThan(0);
    expect(new Set(modes)).toEqual(new Set(["metadata"]));
  });

  it("keeps the turn for a later retry when the store does not take its to-do", async () => {
    engine.queueResults.push({ status: "failed" });
    expect(await saveTurnForUpload(config, toolTurn)).toBe(false);
    expect(engine.warnings.join("\n")).toContain("Keeping the turn for a later retry");
  });

  it("fills the session's repo and each tool's own repo in the uploader", async () => {
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

describe("naming each run's repo from the folder its tools touched", () => {
  it.each([
    ["Read", "file_path"],
    ["Grep", "path"],
    ["Glob", "target_directory"],
    ["Shell", "working_directory"],
  ])("gives a %s run the repo of its %s", async (name, key) => {
    const widget = repo("widget");
    const gadget = repo("gadget");
    const tools = [tool("t1", name, T0 + 1000, { [key]: gadget })];
    const outputs = await buildRuns({ ...toolTurn.buffer, tools }, widget);
    expect(baseOf(outputs, name)).toMatchObject({ repository_name: "acme/gadget" });
  });

  it("gives a subagent's tool the repo of the subagent's own folder", async () => {
    const widget = repo("widget");
    const gadget = repo("gadget");
    writeFileSync(join(gadget, "a.ts"), "");
    const subagentTools = [
      { ...tool("s1", "Read", T0 + 2000, { path: "a.ts" }), workspace_root: gadget },
      { ...tool("s2", "Shell", T0 + 3000, { command: "ls" }), workspace_root: gadget },
    ];
    const subagents = [
      {
        subagent_id: "sub1",
        subagent_type: "explore",
        task: "look",
        startMs: T0 + 1500,
        endMs: T0 + 4000,
        tools: subagentTools,
      },
    ];
    const outputs = await buildRuns({ ...toolTurn.buffer, tools: [], subagents }, widget);
    expect(baseOf(outputs, "Read")).toMatchObject({ repository_name: "acme/gadget" });
    expect(baseOf(outputs, "Shell")).toMatchObject({ repository_name: "acme/gadget" });
  });

  it("resolves a relative path against the tool's folder when the file exists", async () => {
    const widget = repo("widget");
    const gadget = repo("gadget");
    writeFileSync(join(gadget, "a.ts"), "");
    const toward = (file: string) => relative(widget, join(gadget, file));
    const tools = [
      tool("t1", "Read", T0 + 1000, { path: toward("a.ts") }),
      tool("t2", "Glob", T0 + 2000, { target_directory: toward("missing.ts") }),
    ];
    const outputs = await buildRuns({ ...toolTurn.buffer, tools }, widget);
    expect(baseOf(outputs, "Read")).toMatchObject({ repository_name: "acme/gadget" });
    expect(baseOf(outputs, "Glob")).toMatchObject({ repository_name: "acme/widget" });
  });

  it("gives the turn and its model runs the repo its tools touched when the session folder has none", async () => {
    const gadget = repo("gadget");
    const plain = mkdtempSync(join(tmpdir(), "cursor-plain-"));
    const tools = [tool("t1", "Read", T0 + 1000, { path: join(gadget, "a.ts") })];
    const outputs = await buildRuns({ ...toolTurn.buffer, tools }, plain);
    const llms = outputs.filter(({ submission }) => submission.run.name === "cursor");
    expect(baseOf(outputs, "Cursor Turn 1")).toMatchObject({ repository_name: "acme/gadget" });
    expect(llms).toHaveLength(2);
    for (const { submission } of llms) {
      expect(submission.metadata.base).toMatchObject({ repository_name: "acme/gadget" });
    }
  });
});

it.skipIf(process.platform === "win32")(
  "gives the uploader's saved work no destination while the managed file is broken",
  async () => {
    await saveTurnForUpload(config, toolTurn);
    const managed = join(process.env.LS_TEST_ACCOUNT_HOME!, ".langsmith-plugins");
    mkdirSync(managed, { recursive: true });
    writeFileSync(join(managed, "managed.json"), "{}");
    try {
      expect(engine.currentWriter!()).toBeUndefined();
    } finally {
      rmSync(join(managed, "managed.json"));
    }
  },
);

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

  it("rebuilds the same tool runs after the attempt that died saved the root", async () => {
    await saveTool(toolSave);
    const first = (await build()).map(({ eventId }) => eventId);
    engine.saved.set(first[0], { destinationFingerprint: "fingerprint", turnEvidence: {} });
    expect((await build()).map(({ eventId }) => eventId)).toEqual(first);
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
    engine.attachments = [{ type: "image", mime_type: "image/png", base64: "QVRUQUNI" }];
    config = { ...config, attachmentsEnabled: true };
    await saveTool(toolSave);
    expect(JSON.stringify((await build())[0].submission)).toContain("QVRUQUNI");
  });

  it.each([
    ["full", 1],
    ["metadata", 0],
  ] as const)("loads attachments for an early %s root only in full mode", async (mode, loads) => {
    config = { ...config, attachmentsEnabled: true };
    await saveTool({
      ...toolSave,
      buffer: { ...toolTurn.buffer, tracingMode: mode },
    });
    await build();
    expect(engine.attachmentLoads).toBe(loads);
  });

  it("finishes a tool to-do with nothing once its turn has left the state file", async () => {
    await saveTool(toolSave);
    saveState(config.stateFilePath, {});
    expect(await build()).toEqual([]);
  });

  it("builds the turn's root with the model the tool hook saw", async () => {
    await saveTool({ ...toolSave, buffer: { ...toolTurn.buffer, model: "seen-model" } });
    saveState(config.stateFilePath, {
      c1: conversation([{ ...toolTurn.buffer, model: "later-model" }]),
    });
    const [root] = await build();
    expect(JSON.stringify(root.submission.metadata)).toContain("seen-model");
  });

  it("names the turn's saved root as the parent of an early tool run", async () => {
    const [rootPost] = await saveToolEarly("fingerprint");
    const tools = [...toolTurn.buffer.tools, tool("t2", "Read", T0 + 2000)];
    await saveTool({
      ...toolSave,
      buffer: { ...toolTurn.buffer, tools },
      toolIndex: 1,
    });
    const [later] = await build();
    expect(later.dependencies?.map(({ eventId }) => eventId)).toEqual([rootPost]);
  });

  it("leaves a later tool for stop while the turn's root belongs to another account", async () => {
    await saveToolEarly("other-account");
    const tools = [...toolTurn.buffer.tools, tool("t2", "Read", T0 + 2000)];
    const queued = engine.queued.length;
    await saveTool({
      ...toolSave,
      buffer: { ...toolTurn.buffer, tools },
      toolIndex: 1,
    });
    expect(engine.queued).toHaveLength(queued);
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
