import { build } from "esbuild";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import * as url from "node:url";

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

if (!/^\d+\.\d+\.\d+$/.test(version)) {
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

if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME !== `v${version}`) {
  throw new Error(
    `Release tag ${process.env.GITHUB_REF_NAME} does not match package version v${version}`,
  );
}

async function cscNotarizeMacOS() {
  let tmpDir: string | undefined;
  let keychain: string | undefined;
  let originalKeychains: string[] | undefined;

  if (!/^[A-Za-z0-9]+$/.test(process.env.APPLE_API_KEY_ID)) {
    throw new Error("APPLE_API_KEY_ID must be alphanumeric");
  }

  try {
    let identity: string | undefined = "-";
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "langsmith-sea-release-"));

    const [certPath, apiKeyPath] = await Promise.all([
      materializeSecret(
        process.env.CSC_LINK,
        path.join(tmpDir, "developer-id-application.p12"),
        "CSC_LINK",
      ),
      materializeSecret(
        process.env.APPLE_API_KEY,
        path.join(tmpDir, `AuthKey_${process.env.APPLE_API_KEY_ID}.p8`),
        "APPLE_API_KEY",
      ),
    ]);

    keychain = path.join(tmpDir, "app-signing.keychain-db");
    const password = randomBytes(32).toString("hex");
    originalKeychains = [
      ...execFileSync("/usr/bin/security", ["list-keychains", "-d", "user"], {
        encoding: "utf-8",
      }).matchAll(/"([^"]+)"/g),
    ].map((match) => match[1]);

    execFileWithSecrets(
      "/usr/bin/security",
      ["create-keychain", "-p", password, keychain],
      "Failed to create the temporary signing keychain",
    );
    execFileSync("/usr/bin/security", [
      "list-keychains",
      "-d",
      "user",
      "-s",
      keychain,
      ...originalKeychains,
    ]);

    execFileSync("/usr/bin/security", ["set-keychain-settings", "-lut", "21600", keychain]);
    execFileWithSecrets(
      "/usr/bin/security",
      ["unlock-keychain", "-p", password, keychain],
      "Failed to unlock the temporary signing keychain",
    );
    execFileWithSecrets(
      "/usr/bin/security",
      [
        "import",
        certPath,
        "-P",
        process.env.CSC_KEY_PASSWORD,
        "-T",
        "/usr/bin/codesign",
        "-f",
        "pkcs12",
        "-k",
        keychain,
      ],
      "Failed to import CSC_LINK into the temporary signing keychain",
    );
    execFileWithSecrets(
      "/usr/bin/security",
      ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychain],
      "Failed to configure the temporary signing keychain",
    );

    const identities = execFileSync(
      "/usr/bin/security",
      ["find-identity", "-v", "-p", "codesigning", keychain],
      { encoding: "utf-8" },
    );

    identity = [...identities.matchAll(/^\s*\d+\)\s+[0-9A-Fa-f]{40}\s+"([^"]+)"$/gm)]
      .map((match) => match[1])
      .find((name) => name.startsWith("Developer ID Application:"));

    if (!identity) {
      throw new Error("CSC_LINK does not contain a valid Developer ID Application identity");
    }

    // Perform code signing
    execFileSync(
      "/usr/bin/codesign",
      [
        "--force",
        "--options",
        "runtime",
        "--timestamp",
        "--entitlements",
        url.fileURLToPath(new URL("./macos-entitlements.plist", import.meta.url)),
        "--keychain",
        keychain,
        "--sign",
        identity,
        executable,
      ].flat(),
      { stdio: "inherit" },
    );

    execFileSync(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", "--verbose=2", executable],
      { stdio: "inherit" },
    );

    const notarizationArchive = path.join(tmpDir, `${releaseName}-notarization.zip`);

    execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", executable, notarizationArchive], {
      stdio: "inherit",
    });

    const notarization = JSON.parse(
      execFileSync(
        "/usr/bin/xcrun",
        [
          "notarytool",
          "submit",
          notarizationArchive,
          "--key",
          apiKeyPath,
          "--key-id",
          process.env.APPLE_API_KEY_ID,
          "--issuer",
          process.env.APPLE_API_ISSUER,
          "--wait",
          "--timeout",
          "30m",
          "--output-format",
          "json",
        ],
        { encoding: "utf-8" },
      ),
    );
    if (notarization.status !== "Accepted") {
      throw new Error(
        `Apple notarization ${notarization.id ?? "submission"} finished with status ${notarization.status ?? "unknown"}`,
      );
    }
    console.log(`Apple notarization accepted: ${notarization.id}`);

    // Notarization tickets cannot be stapled to standalone Mach-O executables.
    // Apple associates this ticket with the signed executable's code directory.
  } finally {
    if (originalKeychains) {
      try {
        execFileSync("/usr/bin/security", [
          "list-keychains",
          "-d",
          "user",
          "-s",
          ...originalKeychains,
        ]);
      } catch {
        // Preserve the original build error if search-list cleanup also fails.
      }
    }
    if (keychain) {
      try {
        execFileSync("/usr/bin/security", ["delete-keychain", keychain]);
      } catch {
        // Preserve the original build error if keychain cleanup also fails.
      }
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { force: true, recursive: true });
    }
  }
}

async function packageRelease() {
  const packageInputs = [
    executable,
    "hooks/hooks.sea.json",
    ".cursor-plugin/plugin.json",
    "scripts/install.sea.mjs",
    "README.md",
  ];

  await fs.mkdir("dist", { recursive: true });
  await fs.copyFile(executable, releaseExecutable);
  await fs.rm(releaseArchive, { force: true });

  if (os.platform() === "win32") {
    execFileSync("tar.exe", ["-a", "-c", "-f", releaseArchive, ...packageInputs], {
      stdio: "inherit",
    });
  } else if (os.platform() === "darwin") {
    execFileSync("/usr/bin/zip", ["-q", "-r", releaseArchive, ...packageInputs], {
      stdio: "inherit",
    });
  }

  await Promise.all(
    [releaseExecutable, releaseArchive].map(async (input) => {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(input)) {
        hash.update(chunk);
      }
      await fs.writeFile(`${input}.sha256`, `${hash.digest("hex")}  ${path.basename(input)}\n`);
    }),
  );

  console.log(`Built packaged ${releaseName}`);
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
const hasPartialReleaseEnvironment =
  missingReleaseEnvironment.length > 0 &&
  missingReleaseEnvironment.length < releaseEnvironment.length;

if (!isReleaseBuild && (process.env.GITHUB_ACTIONS || hasPartialReleaseEnvironment)) {
  throw new Error(`Missing release environment variables: ${missingReleaseEnvironment.join(", ")}`);
}

if (process.env.GITHUB_REF_TYPE === "tag" && !isReleaseBuild) {
  throw new Error(`Tagged releases require: ${releaseEnvironment.join(", ")}`);
}

async function materializeSecret(value: string, path: string, name: string) {
  let resolvedPath = value;
  const isExplicitPath = value.startsWith("file://");

  if (isExplicitPath) {
    resolvedPath = url.fileURLToPath(value);
  }

  let sourceHandle: fs.FileHandle | undefined;
  let contents: Buffer | undefined;
  try {
    sourceHandle = await fs.open(resolvedPath, "r");
    const sourceStat = await sourceHandle.stat();
    if (!sourceStat.isFile() && !sourceStat.isFIFO() && !sourceStat.isCharacterDevice()) {
      throw new Error(`${name} filesystem input is not a readable file`);
    }
    contents = await sourceHandle.readFile();
  } catch (error) {
    if (isExplicitPath) {
      throw new Error(`${name} filesystem input could not be read`, { cause: error });
    }
    // The value contains the secret itself rather than a file path.
  } finally {
    await sourceHandle?.close().catch(() => undefined);
  }

  if (contents) {
    // Descriptor-backed inputs have already been copied into memory.
  } else if (value.startsWith("data:")) {
    const separator = value.indexOf(",");
    if (separator === -1) {
      throw new Error(`${name} contains an invalid data URL`);
    }
    const metadata = value.slice(0, separator);
    const payload = value.slice(separator + 1);
    contents = Buffer.from(
      decodeURIComponent(payload),
      metadata.endsWith(";base64") ? "base64" : "utf-8",
    );
  } else if (value.includes("-----BEGIN PRIVATE KEY-----")) {
    contents = Buffer.from(value, "utf-8");
  } else if (value.startsWith("base64://")) {
    contents = Buffer.from(value.slice("base64://".length), "base64");
  } else if (value.startsWith("base64:")) {
    contents = Buffer.from(value.slice("base64:".length), "base64");
  } else {
    contents = Buffer.from(value.replace(/\s/g, ""), "base64");
  }

  if (contents.length === 0) {
    throw new Error(`${name} is empty or invalid`);
  }

  const destinationHandle = await fs.open(path, "wx", 0o600);
  try {
    await destinationHandle.writeFile(contents);
    await destinationHandle.sync();
  } finally {
    await destinationHandle.close();
  }
  return path;
}

function execFileWithSecrets(file: string, args: string[], errorMessage: string) {
  try {
    return execFileSync(file, args, { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    // Avoid including credential-bearing command arguments in thrown errors.
    throw new Error(errorMessage);
  }
}

// Perform the SEA build in a temporary directory to avoid polluting the source tree with intermediate artifacts.
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

if (os.platform() === "darwin") {
  await cscNotarizeMacOS();
}

const builtVersion = execFileSync(executable, ["--version"], { encoding: "utf-8" }).trim();
if (builtVersion !== version) {
  throw new Error(`Built executable reports version ${builtVersion}, expected ${version}`);
}

await packageRelease();
