import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const settings = JSON.parse(readFileSync(new URL("binary.config.json", root), "utf8"));
const plugin = JSON.parse(readFileSync(new URL(settings.build.versionFile, root), "utf8"));
const entitlements = readFileSync(new URL(settings.sign.entitlements, root), "utf8");
const binaryPath = fileURLToPath(
  new URL(`${settings.build.outputDirectory}/${settings.executableName}`, root),
);
const built = existsSync(binaryPath);

if (!built && process.env.CI && platform() === "darwin") {
  throw new Error(`Expected 'pnpm build:binary' to have produced ${binaryPath}`);
}

const CONVERSATION = "binary-e2e-conversation";
const GENERATION = "binary-e2e-generation";
const PROMPT = "look at this screenshot";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

let home: string;
let ingest: Server;
let ingestUrl: string;
let ingested: string[] = [];

function seedState(stateFile: string): void {
  writeFileSync(
    stateFile,
    JSON.stringify({
      [CONVERSATION]: {
        turns: {
          [GENERATION]: {
            generation_id: GENERATION,
            startMs: Date.now() - 1000,
            tracingMode: "full",
            prompt: PROMPT,
            tools: [],
            thoughts: [],
            subagents: [],
          },
        },
        turn_count: 0,
        updated: new Date().toISOString(),
      },
    }),
  );
}

function seedDatabase(dbPath: string, imagePath: string | undefined): void {
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run(
    `bubbleId:${CONVERSATION}:one`,
    JSON.stringify({
      type: 1,
      text: PROMPT,
      context: imagePath ? { selectedImages: [{ path: imagePath }] } : {},
    }),
  );
  db.close();
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(
  args: string[],
  input = "",
  extraEnv: Record<string, string> = {},
  command = [binaryPath],
): Promise<Run> {
  const child = spawn(command[0], [...command.slice(1), ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      HOME: home,
      LANGSMITH_CURSOR_LOG_FILE: join(home, "hook.log"),
      LANGSMITH_CURSOR_STATE_FILE: join(home, "state.json"),
      ...extraEnv,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(input);
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function hookLog(): string {
  const path = join(home, "hook.log");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function stopATracedTurn(withImage: boolean, command?: string[]) {
  const dbPath = join(home, "state.vscdb");
  const imagePath = join(home, "shot.png");
  writeFileSync(imagePath, PNG);
  seedDatabase(dbPath, withImage ? imagePath : undefined);
  seedState(join(home, "state.json"));

  return run(
    ["stop"],
    JSON.stringify({
      hook_event_name: "stop",
      conversation_id: CONVERSATION,
      generation_id: GENERATION,
      model: "default",
      status: "completed",
      workspace_roots: [home],
    }),
    {
      TRACE_TO_LANGSMITH: "1",
      LANGSMITH_CURSOR_API_KEY: "test-key",
      LANGSMITH_CURSOR_ENDPOINT: ingestUrl,
      LANGSMITH_CURSOR_PROJECT: "binary-e2e",
      LANGSMITH_CURSOR_DB_PATH: dbPath,
      LANGSMITH_CURSOR_SYSTEM_PROMPT: "false",
    },
    command,
  );
}

async function delivered(): Promise<boolean> {
  const deadline = Date.now() + 20_000;
  while (!ingested.some((body) => body.includes(PROMPT)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return ingested.some((body) => body.includes(PROMPT));
}

beforeAll(async () => {
  ingest = createServer((request, response) => {
    const body: Buffer[] = [];
    request.on("data", (chunk: Buffer) => body.push(chunk));
    request.on("end", () => {
      ingested.push(Buffer.concat(body).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => ingest.listen(0, "127.0.0.1", resolve));
  const address = ingest.address();
  ingestUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  ingest.closeAllConnections();
  await new Promise<void>((resolve) => ingest.close(() => resolve()));
});

beforeEach(() => {
  ingested = [];
  home = mkdtempSync(join(tmpdir(), "ls-cursor-binary-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
});

describe("the macOS entitlements", () => {
  it("grants allow-jit and nothing wider", () => {
    expect(entitlements.match(/<key>([^<]+)<\/key>/g)).toEqual([
      "<key>com.apple.security.cs.allow-jit</key>",
    ]);
  });
});

describe("a cached plugin install without node_modules", () => {
  it("runs every hook and delivers the turn", async () => {
    const pluginBundle = join(home, "plugin", "bundle");
    cpSync(fileURLToPath(new URL("bundle", root)), pluginBundle, { recursive: true });
    const command = [process.execPath, join(pluginBundle, "guard.js")];
    const env = {
      TRACE_TO_LANGSMITH: "1",
      LANGSMITH_CURSOR_API_KEY: "test-key",
      LANGSMITH_CURSOR_ENDPOINT: ingestUrl,
      LANGSMITH_CURSOR_ATTACHMENTS: "false",
      LANGSMITH_CURSOR_SYSTEM_PROMPT: "false",
    };
    const base = {
      conversation_id: CONVERSATION,
      generation_id: GENERATION,
      model: "default",
      workspace_roots: [home],
    };
    const events: Array<[string, Record<string, unknown>]> = [
      ["session-start", { hook_event_name: "sessionStart" }],
      ["before-submit-prompt", { hook_event_name: "beforeSubmitPrompt", prompt: PROMPT }],
      [
        "post-tool-use",
        { hook_event_name: "postToolUse", tool_name: "CachedRead", tool_use_id: "t1" },
      ],
      [
        "post-tool-use-failure",
        { hook_event_name: "postToolUseFailure", tool_name: "CachedFail", tool_use_id: "t2" },
      ],
      [
        "subagent-start",
        { hook_event_name: "subagentStart", subagent_id: "s1", subagent_type: "cached" },
      ],
      [
        "subagent-stop",
        { hook_event_name: "subagentStop", subagent_id: "s1", subagent_type: "cached" },
      ],
      ["after-agent-response", { hook_event_name: "afterAgentResponse", text: "cached answer" }],
      ["stop", { hook_event_name: "stop", status: "completed" }],
    ];
    for (const [hook, payload] of events) {
      const result = await run([hook], JSON.stringify({ ...base, ...payload }), env, command);
      expect(result.status, `${hook}: ${result.stderr}`).toBe(0);
      expect(result.stderr, hook).toBe("");
      if (hook === "before-submit-prompt")
        expect(JSON.parse(result.stdout)).toEqual({ continue: true });
    }
    const names = ["CachedRead", "CachedFail", "cached Subagent", "cached answer", PROMPT];
    const deadline = Date.now() + 20_000;
    while (names.some((name) => !ingested.join("\n").includes(name)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (const name of names) expect(ingested.join("\n")).toContain(name);
  }, 60_000);
});

describe.runIf(built)("the standalone binary", () => {
  it("reports the version from the plugin manifest", async () => {
    const result = await run(["--version"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(plugin.version);
  });

  it("reads Cursor's sqlite database to enrich a traced turn in the uploader", async () => {
    const result = await stopATracedTurn(true);
    expect(result.status, result.stderr).toBe(0);
    expect(await delivered()).toBe(true);
    expect(hookLog()).toContain("attachments: enriched turn with 1 attachment(s)");
  }, 30_000);

  it("delivers the stopped turn from its own background uploader", async () => {
    const result = await stopATracedTurn(false);
    expect(result.status, result.stderr).toBe(0);
    expect(await delivered()).toBe(true);
  }, 30_000);

  it("enriches nothing when the same database holds no attachment", async () => {
    const result = await stopATracedTurn(false);
    expect(result.status, result.stderr).toBe(0);
    expect(await delivered()).toBe(true);
    expect(hookLog()).not.toContain("enriched turn with");
  }, 30_000);
});
