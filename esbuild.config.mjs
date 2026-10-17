import { build } from "esbuild";
import { chmodSync, readFileSync, renameSync } from "node:fs";

// Inject the plugin version at BUILD TIME (the bundle has no runtime
// package.json) via esbuild `define`.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

await build({
  entryPoints: ["dist/src/hooks/dispatch.js", "dist/src/hooks/guard.js"],
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
renameSync("bundle/dispatch.js", "bundle/hooks.js");
chmodSync("bundle/guard.js", 0o755);

console.log("Bundled the hooks into bundle/");
