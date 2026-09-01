#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, execSync, fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_MODE = "--serve";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error(`Missing required option ${name}`);
  }
  return process.argv[index + 1];
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function runServer() {
  const releaseApi = new URL(option("--release-api"));
  const binary = option("--new-binary");
  const version = option("--new-version");
  const assetName = basename(binary);
  const assetPath = `/assets/${encodeURIComponent(assetName)}`;
  const binaryStat = await fs.stat(binary);
  const digest = await sha256(binary);

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", releaseApi.origin);
    console.log(
      `[sea-update-e2e] ${request.method ?? "UNKNOWN"} ${requestUrl.pathname}`,
    );
    if (
      request.method === "GET" &&
      requestUrl.pathname === releaseApi.pathname
    ) {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          tag_name: `v${version}`,
          assets: [
            {
              name: assetName,
              browser_download_url: `${releaseApi.origin}${assetPath}`,
              size: binaryStat.size,
              digest: `sha256:${digest}`,
            },
          ],
        }),
      );
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === assetPath) {
      response.setHeader("Content-Length", String(binaryStat.size));
      const stream = createReadStream(binary);
      stream.on("error", () => response.destroy());
      stream.pipe(response);
      return;
    }

    response.statusCode = 404;
    response.end("Not found");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    const hostname =
      releaseApi.hostname === "[::1]" ? "::1" : releaseApi.hostname;
    server.listen(Number(releaseApi.port), hostname, resolve);
  });

  process.send?.("ready");
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Release server did not start")),
      10_000,
    );
    child.once("message", (message) => {
      if (message !== "ready") return;
      clearTimeout(timeout);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(`Release server exited before startup with code ${code}`),
      );
    });
  });
}

function run(path, args, options = {}) {
  return execFileSync(path, args, {
    encoding: "utf-8",
    timeout: 120_000,
    ...options,
  }).trim();
}

function runCommand(command, options = {}) {
  return execSync(command, {
    encoding: "utf-8",
    timeout: 120_000,
    ...options,
  }).trim();
}

async function runTest() {
  const oldArchive = option("--old-archive");
  const newBinary = option("--new-binary");
  const oldVersion = option("--old-version");
  const newVersion = option("--new-version");
  const releaseApi = new URL(option("--release-api"));

  assert.equal(
    releaseApi.protocol,
    "http:",
    "The E2E server must use HTTP loopback",
  );
  assert.ok(
    ["127.0.0.1", "[::1]", "localhost"].includes(releaseApi.hostname),
    "The E2E server must bind to loopback",
  );
  assert.ok(releaseApi.port, "The E2E release API must specify a port");

  const testRoot = await fs.mkdtemp(
    join(tmpdir(), "langsmith-sea-update-e2e-"),
  );
  const testHome = join(testRoot, "home");
  const oldPackage = join(testRoot, "old-package");
  await fs.mkdir(testHome, { recursive: true });
  await fs.mkdir(oldPackage, { recursive: true });

  const childEnvironment = {
    ...process.env,
    HOME: testHome,
    TRACE_TO_LANGSMITH: "false",
    LANGSMITH_CURSOR_DEBUG: "true",
    LANGSMITH_CURSOR_LOG_FILE: join(testHome, ".cursor", "langsmith-hook.log"),
  };

  let serverProcess;
  try {
    run("/usr/bin/ditto", ["-x", "-k", oldArchive, oldPackage]);
    run(process.execPath, [join(oldPackage, "scripts", "install.sea.mjs")], {
      cwd: oldPackage,
      env: childEnvironment,
    });

    const installedBinary = join(
      testHome,
      ".langsmith",
      "langsmith-cursor-tracing",
    );
    const installedHooks = JSON.parse(
      await fs.readFile(join(testHome, ".cursor", "hooks.json"), "utf-8"),
    );
    const stopCommand = installedHooks.hooks?.stop?.[0]?.command;
    assert.equal(
      typeof stopCommand,
      "string",
      "The installer must configure the Stop hook",
    );
    assert.equal(
      run(installedBinary, ["--version"], {
        cwd: testHome,
        env: childEnvironment,
      }),
      oldVersion,
    );
    run("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      installedBinary,
    ]);
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", newBinary]);

    serverProcess = fork(
      fileURLToPath(import.meta.url),
      [
        SERVER_MODE,
        "--release-api",
        releaseApi.href,
        "--new-binary",
        newBinary,
        "--new-version",
        newVersion,
      ],
      { stdio: ["ignore", "inherit", "inherit", "ipc"] },
    );
    await waitForServer(serverProcess);

    const conversationId = randomUUID();
    const stopPayload = JSON.stringify({
      conversation_id: conversationId,
      generation_id: randomUUID(),
      model: "sea-update-e2e",
      status: "completed",
      loop_count: 0,
      session_id: conversationId,
      hook_event_name: "stop",
      cursor_version: "sea-update-e2e",
      workspace_roots: [testHome],
      user_email: null,
      transcript_path: null,
    });

    runCommand(stopCommand, {
      cwd: testHome,
      env: childEnvironment,
      input: stopPayload,
    });

    const installedVersion = run(installedBinary, ["--version"], {
      cwd: testHome,
      env: childEnvironment,
    });
    if (installedVersion !== newVersion) {
      const hookLog = await fs
        .readFile(childEnvironment.LANGSMITH_CURSOR_LOG_FILE, "utf-8")
        .catch(() => "<no hook log>");
      throw new Error(
        `Installed SEA version is ${installedVersion}, expected ${newVersion}\nHook log:\n${hookLog}`,
      );
    }
    run("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      installedBinary,
    ]);
    console.log(`SEA auto-update E2E passed: ${oldVersion} -> ${newVersion}`);
  } finally {
    serverProcess?.kill("SIGTERM");
    await fs.rm(testRoot, { recursive: true, force: true });
  }
}

if (process.argv[2] === SERVER_MODE) {
  await runServer();
} else {
  await runTest();
}
