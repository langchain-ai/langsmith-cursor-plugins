import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { BINARY_HOOK_EVENTS } from "../src/constants.js";
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
