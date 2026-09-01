#!/usr/bin/env node
/**
 * Install the LangSmith tracing hooks into Cursor's hooks.json.
 *
 * Usage:
 *   node scripts/install.sea.mjs            # user-global: ~/.cursor/hooks.json (default)
 *   node scripts/install.sea.mjs --project  # project-scoped: ./.cursor/hooks.json
 *   node scripts/install.sea.mjs --print    # print the generated config, don't write
 *
 * The installer copies the SEA to its stable auto-update path and merges the
 * entries into any existing hooks.json (preserving unrelated hooks).
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const executableName = `langsmith-cursor-tracing${platform() === "win32" ? ".exe" : ""}`;
const sourceBin = join(repoRoot, "bin", executableName);
const tracingBin = join(homedir(), ".langsmith", executableName);
const manifest = JSON.parse(
  readFileSync(join(repoRoot, "hooks", "hooks.sea.json"), "utf-8"),
);

if (
  manifest.version !== 1 ||
  !manifest.hooks ||
  typeof manifest.hooks !== "object" ||
  Array.isArray(manifest.hooks)
) {
  throw new Error("hooks.sea.json is not a valid Cursor hooks manifest");
}

if (platform() === "win32") {
  for (const hooks of Object.values(manifest.hooks)) {
    for (const hook of hooks) {
      if (typeof hook.command === "string") {
        hook.command = hook.command.replace(
          'langsmith-cursor-tracing"',
          `${executableName}"`,
        );
      }
    }
  }
}

const args = process.argv.slice(2);
const project = args.includes("--project");
const printOnly = args.includes("--print");

if (!printOnly && !existsSync(sourceBin)) {
  console.error(
    `SEA binary not found at ${sourceBin}. Run \`pnpm build:sea\` first.`,
  );
  process.exit(1);
}

const target = project
  ? join(process.cwd(), ".cursor", "hooks.json")
  : join(homedir(), ".cursor", "hooks.json");

// Merge with any existing hooks.json.
let existing = { version: 1, hooks: {} };
try {
  existing = JSON.parse(readFileSync(target, "utf-8"));
  existing.hooks ??= {};
} catch {
  existing = { version: 1, hooks: {} };
}

const merged = {
  version: existing.version ?? manifest.version,
  hooks: { ...existing.hooks, ...manifest.hooks },
};

const json = JSON.stringify(merged, null, 2);

if (printOnly) {
  console.log(json);
  process.exit(0);
}

mkdirSync(dirname(tracingBin), { recursive: true, mode: 0o700 });
const temporaryBin = `${tracingBin}.${process.pid}.tmp`;
try {
  copyFileSync(sourceBin, temporaryBin);
  chmodSync(temporaryBin, 0o755);
  renameSync(temporaryBin, tracingBin);
} finally {
  try {
    unlinkSync(temporaryBin);
  } catch {
    // The rename succeeded or no temporary file was created.
  }
}

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, json + "\n");

console.log(`Installed LangSmith Cursor hooks → ${target}`);
console.log(`  binary: ${tracingBin}`);
console.log("");
console.log("Next:");
console.log(
  `  1. Configure ${project ? "./.cursor" : "~/.cursor"}/langsmith.json (enabled + api_key + project).`,
);
console.log("  2. Fully restart Cursor so it reloads hooks.json.");
console.log(
  "  3. Run an agent turn; tail ~/.cursor/langsmith-hook.log for activity.",
);
