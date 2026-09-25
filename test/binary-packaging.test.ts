import { execFileSync, spawnSync } from "node:child_process";
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
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { binary } from "../src/binary-target.js";
import {
  BINARY_HOOK_EVENTS,
  PLUGIN_BINARY_DIRECTORY_NAME,
  PLUGIN_LAUNCHER_NAME,
} from "../src/constants.js";
import type { CursorHooksFile } from "../src/types.js";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const settings = JSON.parse(read("binary.config.json"));
const workflow = read(".github/workflows/build-binary.yml");
const lockfile = read("pnpm-lock.yaml");
const pluginHooks = JSON.parse(read("hooks/hooks.json")) as CursorHooksFile;
const binaryHooks = JSON.parse(read(settings.build.defines.__LS_BINARY_HOOKS__)) as CursorHooksFile;

it("stamps the binary with the version the plugin bundle carries", () => {
  const stamped = JSON.parse(read(settings.build.versionFile)) as { version: string };
  const bundled = JSON.parse(read("package.json")) as { version: string };
  expect(stamped.version).toBe(bundled.version);
});

describe("the caller workflow", () => {
  it("builds with the same commit of the shared pipeline the repository installs", () => {
    const pinned = /uses: langchain-ai\/langsmith-plugin-binary\/\S+@([0-9a-f]{40})/.exec(
      workflow,
    )?.[1];

    expect(pinned).toBeDefined();
    expect(lockfile).toContain(`langsmith-plugin-binary/tar.gz/${pinned}`);
  });

  it("keeps the permission and secrets a release upload needs", () => {
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("secrets: inherit");
  });

  it("runs on every file the binary is built from", () => {
    const patterns = workflow
      .slice(workflow.indexOf("paths:"), workflow.indexOf("jobs:"))
      .split("\n")
      .flatMap((line) => (line.startsWith("      - ") ? [line.slice("      - ".length)] : []));
    const inputs = [
      ".github/workflows/build-binary.yml",
      "binary.config.json",
      "package.json",
      "pnpm-lock.yaml",
      settings.build.entryPoint,
      settings.build.versionFile,
      settings.sign.entitlements,
      settings.installer.output,
      ...Object.values(settings.build.defines as Record<string, string>),
    ];

    for (const input of inputs) {
      const covered = patterns.some(
        (pattern) =>
          pattern === input || (pattern.endsWith("/**") && input.startsWith(pattern.slice(0, -2))),
      );
      expect(covered, `${input} is not covered by the paths filter`).toBe(true);
    }
  });
});

describe("the folder the released builds land in", () => {
  const picker = `${PLUGIN_BINARY_DIRECTORY_NAME}/${PLUGIN_LAUNCHER_NAME}`;

  it("starts every hook from the plugin root, on the name its own event routes on", () => {
    for (const [event, hooks] of Object.entries(pluginHooks.hooks ?? {})) {
      const routed = BINARY_HOOK_EVENTS[event as keyof typeof BINARY_HOOK_EVENTS];
      for (const hook of hooks) {
        expect(hook.command.split("\n")[0]).toBe(
          `exec "\${CURSOR_PLUGIN_ROOT}/${picker}" ${routed}`,
        );
      }
    }
  });

  it("survives a clone runnable", () => {
    const mode = execFileSync("git", ["ls-files", "--stage", "--", picker], {
      cwd: new URL(root).pathname,
      encoding: "utf8",
    }).slice(0, 6);
    expect(mode).toBe("100755");
  });

  it("looks for the names the release publishes", () => {
    const script = read(picker);
    for (const [platform, arches] of Object.entries(binary.target.publishedTargets)) {
      for (const arch of arches) {
        expect(script).toContain(`${settings.executableName}-${platform}-${arch}`);
      }
    }
  });

  function sandbox() {
    const plugin = mkdtempSync(join(tmpdir(), "cursor-picker-"));
    const fakeBin = join(plugin, "fake-bin");
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(join(plugin, "binary"), { recursive: true });
    mkdirSync(join(plugin, "bundle"), { recursive: true });
    cpSync(new URL(picker, root).pathname, join(plugin, picker));
    chmodSync(join(plugin, picker), 0o755);
    writeFileSync(
      join(plugin, "bundle", "guard.js"),
      'process.stdout.write("node " + process.argv[2]);\n',
    );

    return {
      plugin,
      build(name: string, { runnable = true } = {}) {
        const path = join(plugin, "binary", name);
        writeFileSync(path, `#!/bin/sh\nprintf '%s %s' "${name}" "$1"\n`);
        chmodSync(path, runnable ? 0o755 : 0o644);
      },
      fakeUname(machine: string, system = "Darwin") {
        const path = join(fakeBin, "uname");
        writeFileSync(
          path,
          `#!/bin/sh\nif [ "$1" = "-m" ]; then echo ${machine}; else echo ${system}; fi\n`,
        );
        chmodSync(path, 0o755);
      },
      pick() {
        return spawnSync(join(plugin, picker), ["stop"], {
          encoding: "utf8",
          env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
        }).stdout;
      },
    };
  }

  it("survives a Windows clone runnable, where Git rewrites line endings", () => {
    const converted = execFileSync(
      "git",
      ["-c", "core.autocrlf=true", "cat-file", "--filters", `:${picker}`],
      { cwd: new URL(root).pathname },
    );
    const { plugin, build, fakeUname, pick } = sandbox();

    try {
      writeFileSync(join(plugin, picker), converted);
      chmodSync(join(plugin, picker), 0o755);
      fakeUname("arm64");
      build(`${settings.executableName}-darwin-arm64`);
      expect(pick()).toBe(`${settings.executableName}-darwin-arm64 stop`);
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  });

  it("picks the Apple silicon build, then the Intel one, then Node", () => {
    const { plugin, build, fakeUname, pick } = sandbox();

    try {
      fakeUname("arm64");
      expect(pick()).toBe("node stop");

      build(`${settings.executableName}-darwin-x64`);
      expect(pick()).toBe(`${settings.executableName}-darwin-x64 stop`);

      build(`${settings.executableName}-darwin-arm64`);
      expect(pick()).toBe(`${settings.executableName}-darwin-arm64 stop`);

      fakeUname("x86_64");
      expect(pick()).toBe(`${settings.executableName}-darwin-x64 stop`);

      rmSync(join(plugin, "binary", `${settings.executableName}-darwin-x64`));
      expect(pick()).toBe("node stop");
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  });

  it("falls back to Node when a build lost its executable bit", () => {
    const { plugin, build, fakeUname, pick } = sandbox();

    try {
      fakeUname("arm64");
      build(`${settings.executableName}-darwin-arm64`, { runnable: false });
      build(`${settings.executableName}-darwin-x64`, { runnable: false });
      expect(pick()).toBe("node stop");
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  });

  it("falls back to Node off a Mac, so a Mac build is never started there", () => {
    const { plugin, build, fakeUname, pick } = sandbox();

    try {
      fakeUname("x86_64", "Linux");
      build(`${settings.executableName}-darwin-arm64`);
      build(`${settings.executableName}-darwin-x64`);
      expect(pick()).toBe("node stop");
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  });

  it("commits the picker and nothing beside it the picker would not run", () => {
    const published = Object.entries(binary.target.publishedTargets).flatMap(([platform, arches]) =>
      arches.map((arch) => `${settings.executableName}-${platform}-${arch}`),
    );
    const committed = execFileSync(
      "git",
      ["ls-files", "--stage", "--", `${PLUGIN_BINARY_DIRECTORY_NAME}/`],
      { cwd: new URL(root).pathname, encoding: "utf8" },
    )
      .trimEnd()
      .split("\n")
      .map((entry) => ({ mode: entry.slice(0, 6), name: entry.slice(entry.lastIndexOf("/") + 1) }));

    expect(committed.map(({ name }) => name)).toContain(PLUGIN_LAUNCHER_NAME);
    for (const { mode, name } of committed) {
      expect([PLUGIN_LAUNCHER_NAME, ...published], name).toContain(name);
      expect(mode, name).toBe("100755");
    }
  });
});

describe("the binary's hooks manifest", () => {
  it("registers exactly the events the plugin registers", () => {
    expect(Object.keys(binaryHooks.hooks ?? {}).sort()).toEqual(
      Object.keys(pluginHooks.hooks ?? {}).sort(),
    );
  });

  it("passes each event the name the dispatcher routes on", () => {
    for (const [event, name] of Object.entries(BINARY_HOOK_EVENTS)) {
      const commands = (binaryHooks.hooks?.[event] ?? []).map((hook) => hook.command);
      expect(commands).toEqual([expect.stringMatching(new RegExp(` ${name}$`))]);
    }
  });

  it("keeps the prompt hook as fail closed as the plugin's", () => {
    const { command: _binaryCommand, ...binaryEntry } =
      binaryHooks.hooks?.beforeSubmitPrompt?.[0] ?? {};
    const { command: _pluginCommand, ...pluginEntry } =
      pluginHooks.hooks?.beforeSubmitPrompt?.[0] ?? {};
    expect(binaryEntry).toEqual(pluginEntry);
  });
});
