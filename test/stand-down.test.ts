import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

import { binary } from "../src/binary-target.js";
import { pluginShouldStandDown } from "../src/stand-down.js";
import { installedBinaryPath } from "../src/installed-binary.js";

const EXECUTABLE_NAME = JSON.parse(
  readFileSync(new URL("../binary.config.json", import.meta.url), "utf8"),
).executableName;
const GUARD = fileURLToPath(new URL("../bundle/guard.js", import.meta.url));
const host = globalThis as { Bun?: { main?: unknown } };

let home: string;
let project: string;
let installed: string;
let savedHome: string | undefined;
let savedCwd: string;

function hooksFile(root: string): string {
  return join(root, ".cursor", "hooks.json");
}

function writeHooks(root: string, ...commands: string[]): void {
  mkdirSync(join(root, ".cursor"), { recursive: true });
  writeFileSync(
    hooksFile(root),
    JSON.stringify({
      version: 1,
      hooks: { beforeSubmitPrompt: commands.map((command) => ({ command })) },
    }),
  );
}

function installBinary(): void {
  mkdirSync(join(home, ".langsmith"), { recursive: true });
  writeFileSync(installed, "#!/bin/sh\n", { mode: 0o755 });
}

function runGuard(hook: string, cwd: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(LANGSMITH_|LANGCHAIN_|TRACE_TO_LANGSMITH)/.test(key),
    ),
  );
  return spawnSync(process.execPath, [GUARD, hook], {
    cwd,
    encoding: "utf8",
    timeout: 15000,
    env: {
      ...env,
      HOME: home,
      USERPROFILE: home,
      TRACE_TO_LANGSMITH: "false",
      LANGSMITH_CURSOR_STATE_FILE: join(home, "state.json"),
      LANGSMITH_CURSOR_PRIVACY_FILE: join(home, "privacy.json"),
      LANGSMITH_CURSOR_LOG_FILE: join(home, "hook.log"),
    },
    input: JSON.stringify({
      prompt: "work",
      generation_id: "generation",
      conversation_id: "thread",
      model: "default",
      hook_event_name: "beforeSubmitPrompt",
      workspace_roots: [cwd],
    }),
  });
}

beforeEach(() => {
  savedCwd = process.cwd();
  savedHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "cursor-standdown-"));
  project = join(home, "project");
  mkdirSync(project);
  installed = join(home, ".langsmith", EXECUTABLE_NAME);
  process.env.HOME = home;
  process.chdir(project);
});

afterEach(() => {
  process.chdir(savedCwd);
  delete host.Bun;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

it("looks for the binary where the installer puts it", () => {
  expect(installedBinaryPath()).toBe(binary.installedBinaryPath());
});

it("stands down before the guard can act on the Node version", () => {
  const source = readFileSync(new URL("../src/hooks/guard.ts", import.meta.url), "utf8");
  expect(
    source.indexOf("pluginShouldStandDown"),
    "a Node too old to trace must not block a turn the binary is tracing",
  ).toBeLessThan(source.indexOf("nodeTooOld("));
});

it("stands down when the user hooks file runs the installed binary", async () => {
  installBinary();
  writeHooks(home, `"${installed}" before-submit-prompt`);
  expect(await pluginShouldStandDown()).toBe(true);
});

it("stands down when only the project hooks file runs the installed binary", async () => {
  installBinary();
  writeHooks(project, `"${installed}" before-submit-prompt`);
  expect(existsSync(hooksFile(home))).toBe(false);
  expect(await pluginShouldStandDown()).toBe(true);
});

it("stands down when the registered command is the bare unquoted path", async () => {
  installBinary();
  writeHooks(home, `${installed} before-submit-prompt`);
  expect(await pluginShouldStandDown()).toBe(true);
});

it("keeps tracing when the registered binary is not on disk", async () => {
  writeHooks(home, `"${installed}" before-submit-prompt`);
  expect(existsSync(installed)).toBe(false);
  expect(await pluginShouldStandDown()).toBe(false);
});

it("keeps tracing when the registered binary cannot be executed", async () => {
  installBinary();
  chmodSync(installed, 0o644);
  writeHooks(home, `"${installed}" before-submit-prompt`);
  expect(await pluginShouldStandDown()).toBe(false);
});

it("keeps tracing when the hooks file registers something else", async () => {
  installBinary();
  for (const command of [
    `"${installed}-lint" before-submit-prompt`,
    `"${join(home, "elsewhere", EXECUTABLE_NAME)}" before-submit-prompt`,
  ]) {
    writeHooks(home, command);
    expect(await pluginShouldStandDown(), command).toBe(false);
  }
});

it("keeps tracing while running as the binary the hooks file registers", async () => {
  installBinary();
  rmSync(installed);
  symlinkSync(process.execPath, installed);
  writeHooks(home, `"${installed}" before-submit-prompt`);
  expect(await pluginShouldStandDown()).toBe(false);
});

it("stands down while running a compiled build that is not the installed one", async () => {
  installBinary();
  writeHooks(home, `"${installed}" before-submit-prompt`);
  writeHooks(project, `"${installed}" before-submit-prompt`);
  host.Bun = { main: `/$bunfs/root/${EXECUTABLE_NAME}` };
  expect(await pluginShouldStandDown()).toBe(true);
});

it("keeps tracing when the hooks file is malformed", async () => {
  installBinary();
  mkdirSync(join(home, ".cursor"), { recursive: true });
  writeFileSync(hooksFile(home), `{"hooks": {"beforeSubmitPrompt": [{"command": "${installed}"`);
  expect(await pluginShouldStandDown()).toBe(false);
});

it("the registered plugin entry point answers nothing while the binary is registered", () => {
  installBinary();
  writeHooks(home, `"${installed}" before-submit-prompt`);
  const result = runGuard("before-submit-prompt", project);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
  expect(existsSync(join(home, "state.json"))).toBe(false);
});

it("the registered plugin entry point traces once the binary is gone", () => {
  installBinary();
  writeHooks(home, `"${installed}" before-submit-prompt`);
  rmSync(installed);
  const result = runGuard("before-submit-prompt", project);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).continue).toBe(true);
  expect(existsSync(join(home, "state.json"))).toBe(true);
});

it("reads the whole payload before standing down, so the writer never sees EPIPE", async () => {
  installBinary();
  writeHooks(home, `"${installed}" stop`);
  const payload = JSON.stringify({
    hook_event_name: "stop",
    conversation_id: "thread",
    generation_id: "generation",
    model: "default",
    status: "completed",
    workspace_roots: [project],
    filler: "x".repeat(512 * 1024),
  });

  const child = spawn(process.execPath, [GUARD, "stop"], {
    cwd: project,
    env: { ...process.env, HOME: home, USERPROFILE: home, TRACE_TO_LANGSMITH: "false" },
  });
  let writerError: string | undefined;
  child.stdin.on("error", (err: NodeJS.ErrnoException) => (writerError = err.code));
  child.stdin.end(payload);
  const status = await new Promise((resolve) => child.on("close", resolve));

  expect(writerError, "Cursor's write to the hook was cut short").toBeUndefined();
  expect(status).toBe(0);
});
