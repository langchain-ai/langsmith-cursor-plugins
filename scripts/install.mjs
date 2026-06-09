#!/usr/bin/env node
/**
 * Install the LangSmith tracing hooks into Cursor's hooks.json.
 *
 * Usage:
 *   node scripts/install.mjs            # user-global: ~/.cursor/hooks.json (default)
 *   node scripts/install.mjs --project  # project-scoped: ./.cursor/hooks.json
 *   node scripts/install.mjs --print    # print the generated config, don't write
 *
 * Why an installer (not a static hooks.json): Cursor spawns hooks from a GUI
 * context without your shell PATH / version manager, so the command must use an
 * absolute node binary and absolute bundle paths. We template both here, and
 * merge into any existing hooks.json (preserving unrelated hooks).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const EVENT_TO_HOOK = {
  beforeSubmitPrompt: "before-submit-prompt.js",
  afterAgentResponse: "after-agent-response.js",
  postToolUse: "post-tool-use.js",
  postToolUseFailure: "post-tool-use-failure.js",
  subagentStart: "subagent-start.js",
  subagentStop: "subagent-stop.js",
  stop: "stop.js",
  sessionStart: "session-start.js",
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const bundleDir = join(repoRoot, "bundle");
const nodeBin = process.execPath; // absolute path to the node running this script

const args = process.argv.slice(2);
const project = args.includes("--project");
const printOnly = args.includes("--print");

if (!existsSync(bundleDir)) {
  console.error(`bundle/ not found at ${bundleDir}. Run \`pnpm build\` first.`);
  process.exit(1);
}

function q(p) {
  return `"${p}"`;
}

// Build our hook entries.
const ourHooks = {};
for (const [event, file] of Object.entries(EVENT_TO_HOOK)) {
  ourHooks[event] = [{ command: `${q(nodeBin)} ${q(join(bundleDir, file))}` }];
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
  version: existing.version ?? 1,
  hooks: { ...existing.hooks, ...ourHooks },
};

const json = JSON.stringify(merged, null, 2);

if (printOnly) {
  console.log(json);
  process.exit(0);
}

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, json + "\n");

console.log(`Installed LangSmith Cursor hooks → ${target}`);
console.log(`  node:   ${nodeBin}`);
console.log(`  bundle: ${bundleDir}`);
console.log("");
console.log("Next:");
console.log(
  `  1. Configure ${project ? "./.cursor" : "~/.cursor"}/langsmith.json (enabled + api_key + project).`,
);
console.log("  2. Fully restart Cursor so it reloads hooks.json.");
console.log("  3. Run an agent turn; tail ~/.cursor/langsmith-hook.log for activity.");
