import { build } from "esbuild";
import { chmodSync } from "node:fs";

const entryPoints = [
  "dist/hooks/before-submit-prompt.js",
  "dist/hooks/after-agent-response.js",
  "dist/hooks/post-tool-use.js",
  "dist/hooks/post-tool-use-failure.js",
  "dist/hooks/subagent-start.js",
  "dist/hooks/subagent-stop.js",
  "dist/hooks/stop.js",
  "dist/hooks/session-start.js",
];

await build({
  entryPoints,
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "bundle",
  // tsc output already has shebangs; esbuild strips them during bundling
  // Mark node builtins as external (they're available at runtime)
  external: ["node:*"],
});

// Make hooks executable
for (const entry of entryPoints) {
  const filename = entry.split("/").pop();
  chmodSync(`bundle/${filename}`, 0o755);
}

console.log(`Bundled ${entryPoints.length} hooks into bundle/`);
