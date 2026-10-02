import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import {
  BINARY_HOOK_EVENTS,
  PLUGIN_BINARY_DIRECTORY_NAME,
  PLUGIN_LAUNCHER_NAME,
  LEADING_BYTE_ORDER_MARKS,
  PLUGIN_ROOT_PLACEHOLDER,
} from "../src/constants.js";
import type { CursorHooksFile } from "../src/types.js";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const settings = JSON.parse(read("binary.config.json"));
const hooks = (JSON.parse(read("hooks/hooks.json")) as CursorHooksFile).hooks ?? {};
const picker = `${PLUGIN_BINARY_DIRECTORY_NAME}/${PLUGIN_LAUNCHER_NAME}`;
const onWindows = process.platform === "win32";
const SHELL_TIMEOUT_MS = 60_000;
const registered = hooks.stop![0].command;
const TURN = '{"hook_event_name":"stop"}';
const SEEN = `${TURN.length}`;
const SENT = `${TURN.length + 1}`;

function sandbox(builds: string[], startable = true): string {
  const dir = mkdtempSync(join(tmpdir(), "cursor hooks "));
  for (const folder of [PLUGIN_BINARY_DIRECTORY_NAME, "bundle", "machine"])
    mkdirSync(join(dir, folder));
  cpSync(fileURLToPath(new URL(picker, root)), join(dir, picker));
  chmodSync(join(dir, picker), 0o755);
  writeFileSync(
    join(dir, "bundle/guard.js"),
    'let turn = "";\nprocess.stdin.on("data", (c) => (turn += c));\n' +
      `process.stdin.on("end", () => { turn = turn.replace(${LEADING_BYTE_ORDER_MARKS}, ""); ` +
      'process.stdout.write("node " + process.argv[2] + " " + turn.length + " " +' +
      " JSON.parse(turn).hook_event_name); });\n",
  );
  writeFileSync(
    join(dir, "machine/uname"),
    '#!/bin/sh\ncase "$1" in -m) echo arm64 ;; *) echo Darwin ;; esac\n',
  );
  chmodSync(join(dir, "machine/uname"), 0o755);
  for (const build of builds) {
    const path = join(dir, PLUGIN_BINARY_DIRECTORY_NAME, build);
    const program = `#!/bin/sh\nturn=$(cat)\nprintf '%s %s %s' "${build}" "$1" "\${#turn}"\n`;
    writeFileSync(path, startable ? program : String.fromCharCode(0, 1) + "not a program at all");
    chmodSync(path, 0o755);
  }
  return dir;
}

function spooled(turn: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "cursor turn ")), "turn.json");
  writeFileSync(path, turn, "utf8");
  return path;
}

function runs(dir: string): string {
  return registered.split(PLUGIN_ROOT_PLACEHOLDER).join(dir);
}

function windowsCommand(dir: string, turn: string): string {
  const payload = spooled(turn).split("'").join("''");
  return (
    "$OutputEncoding = [System.Text.Encoding]::UTF8; " +
    `Get-Content -LiteralPath '${payload}' -Raw | & { $input | & ${runs(dir)} }`
  );
}

function shell(dir: string): string {
  const command = onWindows
    ? windowsCommand(dir, TURN)
    : `${runs(dir)} <<'CURSOR_HOOK_EOF'\n${TURN}\nCURSOR_HOOK_EOF`;
  const environment = { ...process.env, CURSOR_PLUGIN_ROOT: dir };
  const options = {
    encoding: "utf8" as const,
    env: onWindows
      ? environment
      : { ...environment, PATH: `${join(dir, "machine")}${delimiter}${process.env.PATH ?? ""}` },
  };
  const result = onWindows
    ? spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-c", command],
        options,
      )
    : spawnSync("/bin/sh", ["-c", command], options);
  expect(result.error, String(result.error)).toBeUndefined();
  return result.stdout.trim() || `nothing from [${command}] because [${result.stderr.trim()}]`;
}

function inSandbox(builds: string[], check: (dir: string) => void, startable = true): void {
  const dir = sandbox(builds, startable);
  try {
    check(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it("gives every hook one line, so Cursor attaches the event to the line that runs", () => {
  for (const [event, entries] of Object.entries(hooks)) {
    const routed = BINARY_HOOK_EVENTS[event as keyof typeof BINARY_HOOK_EVENTS];
    for (const entry of entries) {
      expect(entry.command).toBe(`"${PLUGIN_ROOT_PLACEHOLDER}/${picker}" ${routed}`);
    }
  }
});

it.runIf(onWindows)(
  "hands Node the whole turn on Windows, and says nothing of its own before that",
  () => {
    inSandbox([], (dir) => {
      const answer = shell(dir);
      expect(answer).toMatch(/^node stop \d+ stop$/);
      expect(Number(answer.split(" ")[2])).toBeGreaterThanOrEqual(TURN.length);
    });
  },
  SHELL_TIMEOUT_MS,
);

it.runIf(!onWindows)(
  "hands the carried build the whole turn, so the prompt hook never blocks a prompt",
  () => {
    const build = `${settings.executableName}-darwin-arm64`;
    inSandbox([build], (dir) => expect(shell(dir)).toBe(`${build} stop ${SEEN}`));
    inSandbox([build], (dir) => expect(shell(dir)).toBe(`node stop ${SENT} stop`), false);
    inSandbox([], (dir) => expect(shell(dir)).toBe(`node stop ${SENT} stop`));
  },
  SHELL_TIMEOUT_MS,
);
