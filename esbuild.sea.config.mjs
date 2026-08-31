import { build } from "esbuild";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { arch, platform, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 25 || (major === 25 && minor < 5)) {
  throw new Error(
    "Building the SEA requires Node.js >= 25.5.0 (--build-sea support)",
  );
}

if (platform() !== "darwin" || arch() !== "arm64") {
  throw new Error(
    `The release binary must be built on darwin-arm64, got ${platform()}-${arch()}`,
  );
}

// Inject the plugin version at build time (the bundle has no runtime package.json) via esbuild `define`.
const { version } = JSON.parse(
  await fs.readFile(new URL("./package.json", import.meta.url), "utf-8"),
);

if (
  process.env.GITHUB_REF_TYPE === "tag" &&
  process.env.GITHUB_REF_NAME !== `v${version}`
) {
  throw new Error(
    `Release tag ${process.env.GITHUB_REF_NAME} does not match package version v${version}`,
  );
}

const outfile = "bundle/sea.cjs";
const executable = "bin/langsmith-cursor-tracing";
const releaseName = "langsmith-cursor-tracing-darwin-arm64";
const releaseExecutable = `dist/${releaseName}`;
const releaseArchive = `dist/${releaseName}.tar.gz`;
const releaseEnvironment = [
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
];
const missingReleaseEnvironment = releaseEnvironment.filter(
  (name) => !process.env[name],
);
const isReleaseBuild = missingReleaseEnvironment.length === 0;

if (
  !isReleaseBuild &&
  (process.env.GITHUB_ACTIONS ||
    missingReleaseEnvironment.length !== releaseEnvironment.length)
) {
  throw new Error(
    `Missing release environment variables: ${missingReleaseEnvironment.join(", ")}`,
  );
}

async function materializeSecret(value, path, name) {
  if (value.startsWith("file://")) {
    return fileURLToPath(value);
  }

  try {
    if ((await fs.stat(value)).isFile()) {
      return value;
    }
  } catch {
    // The value contains the secret itself rather than a file path.
  }

  let contents;
  if (value.startsWith("https://") || value.startsWith("http://")) {
    let response;
    try {
      response = await fetch(value);
    } catch {
      throw new Error(`Failed to download ${name}`);
    }
    if (!response.ok) {
      throw new Error(`Failed to download ${name}: HTTP ${response.status}`);
    }
    contents = Buffer.from(await response.arrayBuffer());
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
  await fs.writeFile(path, contents, { mode: 0o600 });
  return path;
}

function execFileWithSecrets(file, args, errorMessage) {
  try {
    return execFileSync(file, args, {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Avoid including credential-bearing command arguments in thrown errors.
    throw new Error(errorMessage);
  }
}

await fs.rm("bundle", { force: true, recursive: true });
await fs.mkdir("bundle", { recursive: true });

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
  },
});

await fs.chmod(outfile, 0o755);
await fs.mkdir("bin", { recursive: true });
await fs.rm(executable, { force: true });

execFileSync(
  process.execPath,
  ["--build-sea", fileURLToPath(new URL("./sea-config.json", import.meta.url))],
  { stdio: "inherit" },
);

let temporaryDirectory;
let keychain;

try {
  let identity = "-";
  let apiKeyPath;

  if (isReleaseBuild) {
    if (!/^[A-Za-z0-9]+$/.test(process.env.APPLE_API_KEY_ID)) {
      throw new Error("APPLE_API_KEY_ID must be alphanumeric");
    }

    temporaryDirectory = await fs.mkdtemp(
      join(tmpdir(), "langsmith-sea-release-"),
    );
    const certificatePath = await materializeSecret(
      process.env.CSC_LINK,
      join(temporaryDirectory, "developer-id-application.p12"),
      "CSC_LINK",
    );
    apiKeyPath = await materializeSecret(
      process.env.APPLE_API_KEY,
      join(temporaryDirectory, `AuthKey_${process.env.APPLE_API_KEY_ID}.p8`),
      "APPLE_API_KEY",
    );

    keychain = join(temporaryDirectory, "app-signing.keychain-db");
    const keychainPassword = randomBytes(32).toString("hex");
    execFileWithSecrets(
      "/usr/bin/security",
      ["create-keychain", "-p", keychainPassword, keychain],
      "Failed to create the temporary signing keychain",
    );
    execFileSync("/usr/bin/security", [
      "set-keychain-settings",
      "-lut",
      "21600",
      keychain,
    ]);
    execFileWithSecrets(
      "/usr/bin/security",
      ["unlock-keychain", "-p", keychainPassword, keychain],
      "Failed to unlock the temporary signing keychain",
    );
    execFileWithSecrets(
      "/usr/bin/security",
      [
        "import",
        certificatePath,
        "-P",
        process.env.CSC_KEY_PASSWORD,
        "-T",
        "/usr/bin/codesign",
        "-t",
        "cert",
        "-f",
        "pkcs12",
        "-k",
        keychain,
      ],
      "Failed to import CSC_LINK into the temporary signing keychain",
    );
    execFileWithSecrets(
      "/usr/bin/security",
      [
        "set-key-partition-list",
        "-S",
        "apple-tool:,apple:",
        "-k",
        keychainPassword,
        keychain,
      ],
      "Failed to configure the temporary signing keychain",
    );

    identity = execFileSync(
      "/usr/bin/security",
      ["find-identity", "-v", "-p", "codesigning", keychain],
      { encoding: "utf-8" },
    ).match(/\b[0-9A-Fa-f]{40}\b/)?.[0];
    if (!identity) {
      throw new Error("CSC_LINK does not contain a valid signing identity");
    }
  }

  execFileSync(
    "/usr/bin/codesign",
    [
      "--force",
      "--options",
      "runtime",
      identity === "-" ? [] : ["--timestamp"],
      "--entitlements",
      fileURLToPath(new URL("./macos-entitlements.plist", import.meta.url)),
      keychain ? ["--keychain", keychain] : [],
      "--sign",
      identity,
      executable,
    ].flat(),
    { stdio: "inherit" },
  );

  execFileSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", executable],
    {
      stdio: "inherit",
    },
  );

  const builtVersion = execFileSync(executable, ["--version"], {
    encoding: "utf-8",
  }).trim();
  if (builtVersion !== version) {
    throw new Error(
      `Built executable reports version ${builtVersion}, expected ${version}`,
    );
  }

  if (isReleaseBuild) {
    const notarizationArchive = join(
      temporaryDirectory,
      `${releaseName}-notarization.zip`,
    );

    execFileSync(
      "/usr/bin/ditto",
      ["-c", "-k", "--keepParent", executable, notarizationArchive],
      { stdio: "inherit" },
    );

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
  }

  await fs.copyFile(executable, releaseExecutable);
  execFileSync(
    "/usr/bin/tar",
    [
      "-czf",
      releaseArchive,
      executable,
      "hooks/hooks.sea.json",
      ".cursor-plugin/plugin.json",
      "scripts/install.sea.mjs",
      "README.md",
    ],
    { stdio: "inherit" },
  );

  await Promise.all(
    [releaseExecutable, releaseArchive].map(async (path) => {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) {
        hash.update(chunk);
      }
      await fs.writeFile(
        `${path}.sha256`,
        `${hash.digest("hex")}  ${basename(path)}\n`,
      );
    }),
  );

  console.log(
    `Built, signed${isReleaseBuild ? ", notarized" : ""}, and packaged ${releaseName}`,
  );
} finally {
  if (keychain) {
    try {
      execFileSync("/usr/bin/security", ["delete-keychain", keychain]);
    } catch {
      // Preserve the original build error if keychain cleanup also fails.
    }
  }
  if (temporaryDirectory) {
    await fs.rm(temporaryDirectory, { force: true, recursive: true });
  }
}
