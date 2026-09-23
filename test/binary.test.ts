import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { BINARY_HOOK_EVENTS } from "../src/constants.js";
import type { CursorHooksFile } from "../src/types.js";

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

const INSTALL_TIMEOUT_MS = 30_000;
const CONVERSATION = "binary-e2e-conversation";
const GENERATION = "binary-e2e-generation";
const PROMPT = "look at this screenshot";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

let home: string;
let ingest: Server;
let ingestUrl: string;

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

function run(args: string[], input = "", extraEnv: Record<string, string> = {}): Promise<Run> {
  const child = spawn(binaryPath, args, {
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

function stopATracedTurn(withImage: boolean) {
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
  );
}

beforeAll(async () => {
  ingest = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
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
  home = mkdtempSync(join(tmpdir(), "ls-cursor-binary-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("the macOS entitlements", () => {
  it("grants allow-jit and nothing wider", () => {
    expect(entitlements.match(/<key>([^<]+)<\/key>/g)).toEqual([
      "<key>com.apple.security.cs.allow-jit</key>",
    ]);
  });
});

describe.runIf(built)("the standalone binary", () => {
  it("reports the version from the plugin manifest", async () => {
    const result = await run(["--version"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(plugin.version);
  });

  it("reads Cursor's sqlite database to enrich a traced turn", async () => {
    const result = await stopATracedTurn(true);
    expect(result.status, result.stderr).toBe(0);
    expect(hookLog()).toContain("attachments: enriched turn with 1 attachment(s)");
  });

  it("enriches nothing when the same database holds no attachment", async () => {
    const result = await stopATracedTurn(false);
    expect(result.status, result.stderr).toBe(0);
    expect(hookLog()).not.toContain("enriched turn with");
  });

  it("registers every hook against the path it installs itself to", async () => {
    const result = await run(["--install"]);
    expect(result.status, result.stderr).toBe(0);

    const installed = join(home, ".langsmith", settings.executableName);
    expect(existsSync(installed)).toBe(true);

    const hooks = JSON.parse(
      readFileSync(join(home, ".cursor", "hooks.json"), "utf8"),
    ) as CursorHooksFile;
    const commands = Object.values(hooks.hooks ?? {}).flatMap((entries) =>
      entries.map((entry) => entry.command),
    );
    expect(commands).toHaveLength(Object.keys(BINARY_HOOK_EVENTS).length);
    for (const command of commands) expect(command).toContain(`"${installed}"`);
  }, INSTALL_TIMEOUT_MS);

  it("keeps hooks another tool registered for the same event", async () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(
      join(home, ".cursor", "hooks.json"),
      JSON.stringify({ version: 1, hooks: { stop: [{ command: "other-tool stop" }] } }),
    );

    const result = await run(["--install"]);
    expect(result.status, result.stderr).toBe(0);

    const hooks = JSON.parse(
      readFileSync(join(home, ".cursor", "hooks.json"), "utf8"),
    ) as CursorHooksFile;
    expect(hooks.hooks?.stop?.map((entry) => entry.command)).toContain("other-tool stop");
  }, INSTALL_TIMEOUT_MS);

  it("refuses to update from a copy outside the install directory", async () => {
    const installed = join(home, ".langsmith", settings.executableName);
    mkdirSync(join(home, ".langsmith"), { recursive: true });
    writeFileSync(installed, "an older binary", { mode: 0o755 });

    const result = await run(["--update"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("is not the installed binary");
    expect(readFileSync(installed, "utf8")).toBe("an older binary");
  });
});
