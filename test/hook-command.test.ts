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

function sandbox(builds: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cursor hooks "));
  for (const folder of [PLUGIN_BINARY_DIRECTORY_NAME, "bundle", "machine"])
    mkdirSync(join(dir, folder));
  cpSync(fileURLToPath(new URL(picker, root)), join(dir, picker));
  chmodSync(join(dir, picker), 0o755);
  writeFileSync(join(dir, "bundle/guard.js"), 'process.stdout.write("node " + process.argv[2]);\n');
  writeFileSync(
    join(dir, "machine/uname"),
    '#!/bin/sh\ncase "$1" in -m) echo arm64 ;; *) echo Darwin ;; esac\n',
  );
  chmodSync(join(dir, "machine/uname"), 0o755);
  for (const build of builds) {
    const path = join(dir, PLUGIN_BINARY_DIRECTORY_NAME, build);
    writeFileSync(path, `#!/bin/sh\nprintf '%s %s' "${build}" "$1"\n`);
    chmodSync(path, 0o755);
  }
  return dir;
}

function shell(dir: string): string {
  const command = registered.replaceAll("${CURSOR_PLUGIN_ROOT}", dir);
  const options = {
    encoding: "utf8" as const,
    input: "{}",
    env: onWindows
      ? { ...process.env, CURSOR_PLUGIN_ROOT: dir }
      : {
          ...process.env,
          CURSOR_PLUGIN_ROOT: dir,
          PATH: `${join(dir, "machine")}${delimiter}${process.env.PATH ?? ""}`,
        },
  };
  const result = onWindows
    ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], options)
    : spawnSync("/bin/sh", ["-c", command], options);
  expect(result.error, String(result.error)).toBeUndefined();
  return result.stdout.trim();
}

function inSandbox(builds: string[], check: (dir: string) => void): void {
  const dir = sandbox(builds);
  try {
    check(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it("gives every hook a picker line and a Node line carrying the same event", () => {
  for (const [event, entries] of Object.entries(hooks)) {
    const routed = BINARY_HOOK_EVENTS[event as keyof typeof BINARY_HOOK_EVENTS];
    for (const entry of entries) {
      const [starter, fallback, ...extra] = entry.command.split("\n");
      expect(extra, entry.command).toEqual([]);
      expect(starter).toBe(`exec "\${CURSOR_PLUGIN_ROOT}/${picker}" ${routed}`);
      expect(fallback).toBe(`node "\${CURSOR_PLUGIN_ROOT}/bundle/guard.js" ${routed}`);
    }
  }
});

it.runIf(onWindows)(
  "reaches Node through PowerShell, which cannot start the picker",
  () => {
    inSandbox([], (dir) => expect(shell(dir)).toBe("node stop"));
  },
  SHELL_TIMEOUT_MS,
);

it.runIf(!onWindows)(
  "runs the carried build through a POSIX shell, and Node when none is carried",
  () => {
    const build = `${settings.executableName}-darwin-arm64`;
    inSandbox([build], (dir) => expect(shell(dir)).toBe(`${build} stop`));
    inSandbox([], (dir) => expect(shell(dir)).toBe("node stop"));
  },
  SHELL_TIMEOUT_MS,
);
