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
  PLUGIN_ROOT_PLACEHOLDER,
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
        expect(hook.command).toBe(`"${PLUGIN_ROOT_PLACEHOLDER}/${picker}" ${routed}`);
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
    const plugin = mkdtempSync(join(tmpdir(), "cursor picker "));
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
      unstartableBuild(name: string) {
        const path = join(plugin, "binary", name);
        writeFileSync(path, `${String.fromCharCode(0, 1)}not a program at all`);
        chmodSync(path, 0o755);
      },
      killedBuild(name: string) {
        const path = join(plugin, "binary", name);
        writeFileSync(path, "#!/bin/sh\nkill -9 $$\n");
        chmodSync(path, 0o755);
      },
      buildKilledMidTurn(name: string) {
        const path = join(plugin, "binary", name);
        writeFileSync(path, "#!/bin/sh\ndd bs=1 count=64 of=/dev/null 2>/dev/null\nkill -9 $$\n");
        chmodSync(path, 0o755);
      },
      buildKilledAfterAnswering(name: string) {
        const path = join(plugin, "binary", name);
        writeFileSync(path, `#!/bin/sh\ncat >/dev/null\nprintf '%s answered' "${name}"\nkill -9 $$\n`);
        chmodSync(path, 0o755);
      },
      refusingBuild(name: string) {
        const path = join(plugin, "binary", name);
        writeFileSync(path, `#!/bin/sh\nprintf '%s refused' "${name}"\nexit 3\n`);
        chmodSync(path, 0o755);
      },
      blockingBuild(name: string) {
        const path = join(plugin, "binary", name);
        writeFileSync(path, `#!/bin/sh\nprintf '%s blocked' "${name}"\nexit 2\n`);
        chmodSync(path, 0o755);
      },
      buildReportingTurnPermissions(name: string) {
        const path = join(plugin, "binary", name);
        const report = 'process.stdout.write(require("fs").fstatSync(0).mode.toString(8).slice(-3))';
        writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" -e '${report}'\n`);
        chmodSync(path, 0o755);
      },
      countingBuild(name: string) {
        const path = join(plugin, "binary", name);
        writeFileSync(path, "#!/bin/sh\nprintf 'build %s bytes' \"$(wc -c | tr -d ' ')\"\n");
        chmodSync(path, 0o755);
      },
      countingGuard() {
        const counts = 'let n=0;process.stdin.on("data",(c)=>{n+=c.length});';
        const reports = 'process.stdin.on("end",()=>process.stdout.write("node "+n+" bytes"));\n';
        writeFileSync(join(plugin, "bundle", "guard.js"), counts + reports);
      },
      attempt(input?: string) {
        return spawnSync("/bin/sh", ["-c", `"${join(plugin, picker)}" stop`], {
          encoding: "utf8",
          input,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
        });
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
        return spawnSync("/bin/sh", ["-c", `"${join(plugin, picker)}" stop`], {
          encoding: "utf8",
          input: "",
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

  it("hands Node the whole turn when a build dies part way through reading it", () => {
    const { plugin, buildKilledMidTurn, countingGuard, fakeUname, attempt } = sandbox();

    try {
      fakeUname("arm64");
      countingGuard();
      buildKilledMidTurn(`${settings.executableName}-darwin-arm64`);
      buildKilledMidTurn(`${settings.executableName}-darwin-x64`);
      expect(attempt("x".repeat(1_048_576)).stdout).toBe("node 1048576 bytes");
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  });

  it("keeps the spooled turn readable only by the user whose prompt it holds", () => {
    const { plugin, buildReportingTurnPermissions, fakeUname, attempt } = sandbox();

    try {
      fakeUname("arm64");
      buildReportingTurnPermissions(`${settings.executableName}-darwin-arm64`);
      expect(attempt("a turn nobody else may read").stdout).toBe("600");
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  });

  it("throws away a dead build's answer so the turn is only answered once", () => {
    const { plugin, buildKilledAfterAnswering, fakeUname, pick } = sandbox();

    try {
      fakeUname("arm64");
      buildKilledAfterAnswering(`${settings.executableName}-darwin-arm64`);
      buildKilledAfterAnswering(`${settings.executableName}-darwin-x64`);
      expect(pick()).toBe("node stop");
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  });

  it("falls back to Node on a Mac it carries no build for", () => {
    const { plugin, build, fakeUname, pick } = sandbox();

    try {
      fakeUname("i386");
      build(`${settings.executableName}-darwin-arm64`);
      build(`${settings.executableName}-darwin-x64`);
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

  it("falls back to Node when every carried build is too broken to start", () => {
    const { plugin, unstartableBuild, fakeUname, pick } = sandbox();

    try {
      fakeUname("arm64");
      unstartableBuild(`${settings.executableName}-darwin-arm64`);
      unstartableBuild(`${settings.executableName}-darwin-x64`);
      expect(pick()).toBe("node stop");
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  });

  it("falls back to Node when a build is killed the moment it starts", () => {
    const { plugin, killedBuild, fakeUname, pick } = sandbox();

    try {
      fakeUname("arm64");
      killedBuild(`${settings.executableName}-darwin-arm64`);
      killedBuild(`${settings.executableName}-darwin-x64`);
      expect(pick()).toBe("node stop");
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  });

  it("tries the Intel build when the Apple silicon one cannot start", () => {
    const { plugin, build, unstartableBuild, fakeUname, pick } = sandbox();

    try {
      fakeUname("arm64");
      unstartableBuild(`${settings.executableName}-darwin-arm64`);
      build(`${settings.executableName}-darwin-x64`);
      expect(pick()).toBe(`${settings.executableName}-darwin-x64 stop`);
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  });

  it("traces the turn with Node when a carried build answers with anything but zero", () => {
    const { plugin, refusingBuild, fakeUname, attempt } = sandbox();

    try {
      fakeUname("arm64");
      refusingBuild(`${settings.executableName}-darwin-arm64`);
      const result = attempt();
      expect(result.stdout).toBe("node stop");
      expect(result.status).toBe(0);
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  });

  it("traces the turn with Node when a broken build lands on Cursor's block code", () => {
    const { plugin, blockingBuild, fakeUname, attempt } = sandbox();

    try {
      fakeUname("arm64");
      blockingBuild(`${settings.executableName}-darwin-arm64`);
      const result = attempt();
      expect(result.stdout).toBe("node stop");
      expect(result.status).toBe(0);
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  });

  it("says once that a carried build could not run, so the fallback is never silent", () => {
    const { plugin, unstartableBuild, fakeUname, attempt } = sandbox();

    try {
      fakeUname("arm64");
      unstartableBuild(`${settings.executableName}-darwin-arm64`);
      const said = attempt().stderr.split("\n").filter((line) => line.includes("[langsmith]"));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain("carried build did not run");
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  });

  it("stays quiet when the carried build runs, so nothing precedes the Windows half", () => {
    const { plugin, build, fakeUname, attempt } = sandbox();

    try {
      fakeUname("arm64");
      build(`${settings.executableName}-darwin-arm64`);
      expect(attempt().stderr).toBe("");
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  });

  it("hands Node a turn far larger than a pipe buffer when no build starts", () => {
    const { plugin, unstartableBuild, countingGuard, fakeUname, attempt } = sandbox();

    try {
      fakeUname("arm64");
      countingGuard();
      unstartableBuild(`${settings.executableName}-darwin-arm64`);
      unstartableBuild(`${settings.executableName}-darwin-x64`);
      expect(attempt("x".repeat(1_048_576)).stdout).toBe("node 1048576 bytes");
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  });

  it("hands a working build a turn far larger than a pipe buffer", () => {
    const { plugin, countingBuild, fakeUname, attempt } = sandbox();

    try {
      fakeUname("arm64");
      countingBuild(`${settings.executableName}-darwin-arm64`);
      expect(attempt("x".repeat(1_048_576)).stdout).toBe("build 1048576 bytes");
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
