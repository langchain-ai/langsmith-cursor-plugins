import * as fs from "node:fs/promises";
import { cscNotarizeMacOS, packageRelease } from "./macos-signing.mts";

// This entry point uses only Node builtins and Apple tools. Never execute the
// downloaded binary, package scripts, or dependency code on the signing runner.
if (
  process.platform !== "darwin" ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.GITHUB_EVENT_NAME !== "push" ||
  process.env.GITHUB_REF_TYPE !== "tag" ||
  process.env.GITHUB_REPOSITORY !== "langchain-ai/langsmith-cursor-plugins"
) {
  throw new Error("Production signing requires a release-tag push in the upstream repository");
}
const { version } = JSON.parse(await fs.readFile("package.json", "utf-8"));
if (
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/.test(
    version,
  ) ||
  process.env.GITHUB_REF_NAME !== version
) {
  throw new Error("Release tag must match the package version");
}
const teamId = process.env.APPLE_TEAM_ID;
if (!teamId || !/^[A-Z0-9]{10}$/.test(teamId)) throw new Error("Invalid APPLE_TEAM_ID");
for (const name of [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
]) {
  if (!process.env[name]) throw new Error(`Missing signing secret: ${name}`);
}
const executable = "bin/langsmith-cursor-tracing";
const stat = await fs.lstat(executable);
if (!stat.isFile() || stat.isSymbolicLink())
  throw new Error("Release input must be a regular file");
await fs.chmod(executable, 0o755);
const releaseName = `langsmith-cursor-tracing-darwin-arm64-${version}`;
await cscNotarizeMacOS(executable, releaseName, teamId);
await packageRelease(executable, `dist/${releaseName}`, `dist/${releaseName}.zip`);
