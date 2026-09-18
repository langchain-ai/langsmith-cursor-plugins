import {
  cscNotarizeMacOS,
  packageRelease,
  inferMacTeamIdFromSigningCertificate,
} from "./scripts/macos-signing.mts";
import { build } from "esbuild";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import * as path from "node:path";

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      APPLE_API_KEY: string;
      APPLE_API_KEY_ID: string;
      APPLE_API_ISSUER: string;
      CSC_LINK: string;
      CSC_KEY_PASSWORD: string;
      LANGSMITH_CURSOR_INTERNAL_VERSION: string;
      LANGSMITH_CURSOR_INTERNAL_RELEASE_API: string;
    }
  }
}

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 25 || (major === 25 && minor < 5)) {
  throw new Error("Building the SEA requires Node.js >= 25.5.0 (--build-sea support)");
}

const buildTarget = `${os.platform()}-${os.arch()}`;
const supportedBuildTargets = new Set(["darwin-arm64", "win32-arm64", "win32-x64"]);
if (!supportedBuildTargets.has(buildTarget)) {
  throw new Error(`Unsupported SEA build target: ${buildTarget}`);
}

const packageJson = JSON.parse(
  await fs.readFile(new URL("./package.json", import.meta.url), "utf-8"),
);
const version = process.env.LANGSMITH_CURSOR_INTERNAL_VERSION ?? packageJson.version;
const internalReleaseApi = process.env.LANGSMITH_CURSOR_INTERNAL_RELEASE_API;
const releaseApi =
  internalReleaseApi ??
  "https://api.github.com/repos/langchain-ai/langsmith-cursor-plugins/releases/latest";

if (
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/.test(
    version,
  )
) {
  throw new Error(`Invalid SEA version: ${version}`);
}

const releaseApiUrl = new URL(releaseApi);
if (
  internalReleaseApi &&
  (!["http:", "https:"].includes(releaseApiUrl.protocol) ||
    !["127.0.0.1", "[::1]", "localhost"].includes(releaseApiUrl.hostname))
) {
  throw new Error("The internal release API must use an HTTP(S) loopback URL");
}

if (
  process.env.GITHUB_REF_TYPE === "tag" &&
  (process.env.LANGSMITH_CURSOR_INTERNAL_VERSION ||
    process.env.LANGSMITH_CURSOR_INTERNAL_RELEASE_API)
) {
  throw new Error("Internal SEA build overrides cannot be used for a tagged release");
}

if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME !== version) {
  throw new Error(
    `Release tag ${process.env.GITHUB_REF_NAME} does not match package version ${version}`,
  );
}

const outfile = "bundle/sea.cjs";

const executableExt = os.platform() === "win32" ? ".exe" : "";
const executable = `bin/langsmith-cursor-tracing${executableExt}`;

const releaseStem = `langsmith-cursor-tracing-${os.platform()}-${os.arch()}-${version}`;
const releaseName = `${releaseStem}${executableExt}`;

const releaseExecutable = `dist/${releaseName}`;
const releaseArchive = `dist/${releaseStem}.zip`;

const releaseEnvironment =
  os.platform() === "darwin"
    ? ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "CSC_LINK", "CSC_KEY_PASSWORD"]
    : [];

const missingReleaseEnvironment = releaseEnvironment.filter((name) => !process.env[name]);
const isReleaseBuild = missingReleaseEnvironment.length === 0;
const isUnsignedCiBuild = process.env.LANGSMITH_CURSOR_UNSIGNED_BUILD === "true";
const hasPartialReleaseEnvironment =
  missingReleaseEnvironment.length > 0 &&
  missingReleaseEnvironment.length < releaseEnvironment.length;

if (
  (process.env.GITHUB_ACTIONS || isUnsignedCiBuild) &&
  missingReleaseEnvironment.length < releaseEnvironment.length
) {
  throw new Error(
    "Build jobs must not receive Apple secrets; use the isolated release signing job",
  );
}

if (
  !isReleaseBuild &&
  !isUnsignedCiBuild &&
  (process.env.GITHUB_ACTIONS || hasPartialReleaseEnvironment)
) {
  throw new Error(`Missing release environment variables: ${missingReleaseEnvironment.join(", ")}`);
}

if (process.env.GITHUB_REF_TYPE === "tag" && !isReleaseBuild && !isUnsignedCiBuild) {
  throw new Error(`Tagged releases require: ${releaseEnvironment.join(", ")}`);
}

// Perform the SEA build in a temporary directory to avoid polluting the source tree with intermediate artifacts.
const macTeamId =
  os.platform() === "darwin"
    ? process.env.APPLE_TEAM_ID ||
      (isReleaseBuild ? await inferMacTeamIdFromSigningCertificate() : "")
    : "";
if (macTeamId && !/^[A-Z0-9]{10}$/.test(macTeamId)) {
  throw new Error("APPLE_TEAM_ID must be a 10-character Apple team ID");
}
if (os.platform() === "darwin" && process.env.GITHUB_REF_TYPE === "tag" && !macTeamId) {
  throw new Error("Tagged macOS builds require the public APPLE_TEAM_ID repository variable");
}
await fs.mkdir("bundle", { recursive: true });
await fs.rm(outfile, { force: true });

await build({
  entryPoints: ["dist/sea.js"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22.13",
  outfile,
  // Node builtins are supplied by the runtime embedded in the SEA.
  external: ["node:*"],
  define: {
    // Build-time injection of the plugin (integration) version. Consumed by
    // config.ts via `typeof __LS_INTEGRATION_VERSION__` → ls_integration_version.
    __LS_INTEGRATION_VERSION__: JSON.stringify(version),
    __LS_RELEASE_API__: JSON.stringify(releaseApi),
    __LS_MAC_TEAM_ID__: JSON.stringify(macTeamId),
  },
});

await fs.chmod(outfile, 0o755);
await fs.mkdir("bin", { recursive: true });
await fs.rm(executable, { force: true });

const seaConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "langsmith-sea-config-"));
try {
  const seaConfigPath = path.join(seaConfigDir, "sea-config.json");
  await fs.writeFile(
    seaConfigPath,
    await (async () => {
      const config = JSON.parse(
        await fs.readFile(new URL("./sea-config.json", import.meta.url), "utf-8"),
      );

      config.main = path.resolve(config.main);
      config.output = path.resolve(executable);

      return `${JSON.stringify(config, null, 2)}\n`;
    })(),
  );
  execFileSync(process.execPath, ["--build-sea", seaConfigPath], { stdio: "inherit" });
} finally {
  await fs.rm(seaConfigDir, { force: true, recursive: true });
}

if (os.platform() === "darwin" && !isReleaseBuild) {
  // macOS refuses to execute an injected SEA without at least an ad-hoc
  // signature. Release builds replace this with the Developer ID signature.
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", executable], {
    stdio: "inherit",
  });
}

if (os.platform() === "darwin" && isReleaseBuild) {
  await cscNotarizeMacOS(executable, releaseName, macTeamId);
}

const builtVersion = execFileSync(executable, ["--version"], { encoding: "utf-8" }).trim();
if (builtVersion !== version) {
  throw new Error(`Built executable reports version ${builtVersion}, expected ${version}`);
}

await packageRelease(executable, releaseExecutable, releaseArchive);
