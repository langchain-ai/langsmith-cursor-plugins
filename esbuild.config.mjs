import { build } from "esbuild";
import { chmodSync, readFileSync } from "node:fs";

// Inject the plugin version at BUILD TIME (the bundle has no runtime
// package.json) via esbuild `define`.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

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
  define: {
    // Build-time injection of the plugin (integration) version. Consumed by
    // config.ts via `typeof __LS_INTEGRATION_VERSION__` → ls_integration_version.
    __LS_INTEGRATION_VERSION__: JSON.stringify(pkg.version),
  },
});

// Make hooks executable
for (const entry of entryPoints) {
  const filename = entry.split("/").pop();
  chmodSync(`bundle/${filename}`, 0o755);
}

console.log(`Bundled ${entryPoints.length} hooks into bundle/`);
