import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { debug } from "./logger.js";
import { LS_INTEGRATION_VERSION } from "./version.js";

declare const __LS_RELEASE_API__: string;

const DEFAULT_RELEASE_API =
  "https://api.github.com/repos/langchain-ai/langsmith-cursor-plugins/releases/latest";
const RELEASE_API =
  typeof __LS_RELEASE_API__ !== "undefined" ? __LS_RELEASE_API__ : DEFAULT_RELEASE_API;
const EXECUTABLE_NAME = "langsmith-cursor-tracing";
const SUPPORTED_TARGETS: Readonly<Record<string, ReadonlySet<string>>> = {
  darwin: new Set(["arm64"]),
  linux: new Set(["arm64", "x64"]),
  win32: new Set(["arm64", "x64"]),
};

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const LOCK_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_BINARY_BYTES = 250 * 1024 * 1024;

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
  digest?: string | null;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
}

export type UpdateResult =
  | { status: "not-installed" | "unsupported" | "throttled" | "busy" | "current" }
  | { status: "updated" | "scheduled"; version: string };

export interface SeaReleaseTarget {
  assetName: string;
  executableName: string;
}

export interface UpdateOptions {
  currentVersion?: string;
  installDir?: string;
  executablePath?: string;
  fetchImpl?: typeof fetch;
  verifySignature?: (path: string) => Promise<void>;
  now?: () => number;
  checkIntervalMs?: number;
  runtimePlatform?: NodeJS.Platform;
  runtimeArch?: string;
}

export function getSeaReleaseTarget(
  runtimePlatform: NodeJS.Platform,
  runtimeArch: string,
  version: string,
): SeaReleaseTarget | undefined {
  if (!SUPPORTED_TARGETS[runtimePlatform]?.has(runtimeArch)) return undefined;
  const extension = runtimePlatform === "win32" ? ".exe" : "";
  const normalizedVersion = version.replace(/^v/, "");
  return {
    // Keep the Electron update-server convention: app-platform-arch-version.ext.
    assetName: `${EXECUTABLE_NAME}-${runtimePlatform}-${runtimeArch}-${normalizedVersion}${extension}`,
    executableName: `${EXECUTABLE_NAME}${extension}`,
  };
}

function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isVersionNewer(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  if (!next || !installed) return false;
  for (let i = 0; i < next.length; i += 1) {
    if (next[i] !== installed[i]) return next[i] > installed[i];
  }
  return false;
}

function parseRelease(value: unknown): GitHubRelease {
  if (!value || typeof value !== "object") throw new Error("invalid GitHub release response");
  const release = value as Record<string, unknown>;
  if (typeof release.tag_name !== "string" || !Array.isArray(release.assets)) {
    throw new Error("invalid GitHub release response");
  }

  const assets = release.assets.filter((asset): asset is GitHubAsset => {
    if (!asset || typeof asset !== "object") return false;
    const item = asset as Record<string, unknown>;
    return (
      typeof item.name === "string" &&
      typeof item.browser_download_url === "string" &&
      typeof item.size === "number" &&
      (item.digest === undefined || item.digest === null || typeof item.digest === "string")
    );
  });
  return { tag_name: release.tag_name, assets };
}

function expectedSha256(asset: GitHubAsset): string {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest ?? "");
  if (!match) throw new Error(`release asset ${asset.name} has no valid SHA-256 digest`);
  return match[1].toLowerCase();
}

async function verifyMacSignature(path: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    execFile(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", path],
      { timeout: 15_000 },
      (error) => (error ? reject(error) : resolvePromise()),
    );
  });
}

function defaultSignatureVerifier(
  runtimePlatform: NodeJS.Platform,
): ((path: string) => Promise<void>) | undefined {
  if (runtimePlatform === "darwin") return verifyMacSignature;
  return undefined;
}

async function scheduleWindowsReplacement(
  source: string,
  target: string,
  installDir: string,
  now: number,
): Promise<void> {
  const script = path.join(installDir, `.update.${process.pid}.${now}.ps1`);
  await fs.writeFile(
    script,
    `param([string]$Source, [string]$Target, [int]$ParentPid)
try {
  Wait-Process -Id $ParentPid -ErrorAction SilentlyContinue
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
      Move-Item -LiteralPath $Source -Destination $Target -Force -ErrorAction Stop
      exit 0
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  exit 1
} finally {
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
`,
    { mode: 0o600 },
  );

  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      source,
      target,
      String(process.pid),
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  try {
    await new Promise<void>((resolvePromise, reject) => {
      child.once("spawn", resolvePromise);
      child.once("error", reject);
    });
  } catch (error) {
    await fs.unlink(script).catch(() => undefined);
    throw error;
  }
  child.unref();
}

async function acquireLock(path: string, now: number) {
  try {
    return await fs.open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  let existingLock: fs.FileHandle | undefined;
  try {
    existingLock = await fs.open(path, "r");
    const lockStat = await existingLock.stat();
    if (now - lockStat.mtimeMs <= LOCK_MAX_AGE_MS) return undefined;
  } catch {
    return undefined;
  } finally {
    await existingLock?.close().catch(() => undefined);
  }

  try {
    await fs.unlink(path);
    return await fs.open(path, "wx", 0o600);
  } catch {
    return undefined;
  }
}

async function openUpdateCheck(path: string): Promise<fs.FileHandle> {
  try {
    return await fs.open(path, "r+");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    return await fs.open(path, "wx+", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return await fs.open(path, "r+");
  }
}

async function downloadAsset(
  asset: GitHubAsset,
  destination: string,
  fetchImpl: typeof fetch,
  currentVersion: string,
  releaseApi: string,
): Promise<void> {
  if (asset.size <= 0 || asset.size > MAX_BINARY_BYTES) {
    throw new Error(`release asset size ${asset.size} is outside the allowed range`);
  }
  const downloadUrl = new URL(asset.browser_download_url);
  const isProductionReleaseApi = releaseApi === DEFAULT_RELEASE_API;
  const isAllowedDownload = isProductionReleaseApi
    ? downloadUrl.origin === "https://github.com" &&
      downloadUrl.pathname.startsWith("/langchain-ai/langsmith-cursor-plugins/releases/download/")
    : downloadUrl.origin === new URL(releaseApi).origin;
  if (!isAllowedDownload) {
    throw new Error("release asset has an unexpected download URL");
  }
  const expectedDigest = expectedSha256(asset);

  const response = await fetchImpl(downloadUrl, {
    headers: { "User-Agent": `langsmith-cursor/${currentVersion}` },
    signal: AbortSignal.timeout(5 * 60_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`failed to download release asset: HTTP ${response.status}`);
  }

  const handle = await fs.open(destination, "wx", 0o700);
  const hash = createHash("sha256");
  let bytesWritten = 0;
  try {
    for await (const rawChunk of response.body) {
      const chunk = Buffer.from(rawChunk);
      bytesWritten += chunk.byteLength;
      if (bytesWritten > MAX_BINARY_BYTES || bytesWritten > asset.size) {
        throw new Error("downloaded release asset exceeds its declared size");
      }
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const result = await handle.write(chunk, offset);
        if (result.bytesWritten === 0) throw new Error("could not write release asset");
        offset += result.bytesWritten;
      }
    }
    await handle.sync();
  } finally {
    await handle.close();
  }

  if (bytesWritten !== asset.size) {
    throw new Error(`release asset size mismatch: expected ${asset.size}, got ${bytesWritten}`);
  }
  if (hash.digest("hex") !== expectedDigest) {
    throw new Error("release asset SHA-256 mismatch");
  }
}

export async function updateFromGitHub(options: UpdateOptions = {}): Promise<UpdateResult> {
  const currentVersion = options.currentVersion ?? LS_INTEGRATION_VERSION;
  if (!currentVersion) return { status: "current" };

  const runtimePlatform = options.runtimePlatform ?? os.platform();
  const runtimeArch = options.runtimeArch ?? os.arch();
  const installedTarget = getSeaReleaseTarget(runtimePlatform, runtimeArch, currentVersion);
  if (!installedTarget) return { status: "unsupported" };

  const installDir = options.installDir ?? path.join(os.homedir(), ".langsmith");
  const target = path.join(installDir, installedTarget.executableName);
  const executablePath = options.executablePath ?? process.execPath;
  const [canonicalExecutablePath, canonicalTarget] = await Promise.all([
    fs.realpath(executablePath),
    fs.realpath(target),
  ]);
  if (canonicalExecutablePath !== canonicalTarget) {
    debug(`Skipping auto-update outside install path: ${executablePath} != ${target}`);
    return { status: "not-installed" };
  }

  const now = (options.now ?? Date.now)();
  const checkIntervalMs = options.checkIntervalMs ?? CHECK_INTERVAL_MS;
  const checkedFile = path.join(installDir, ".last-update-check");
  const lockFile = path.join(installDir, ".update.lock");
  await fs.mkdir(installDir, { recursive: true, mode: 0o700 });

  let checkedHandle: fs.FileHandle | undefined;
  try {
    checkedHandle = await fs.open(checkedFile, "r+");
    const checked = await checkedHandle.stat();
    if (now - checked.mtimeMs < checkIntervalMs) {
      await checkedHandle.close();
      return { status: "throttled" };
    }
  } catch {
    await checkedHandle?.close().catch(() => undefined);
    checkedHandle = undefined;
    // First check.
  }

  const lock = await acquireLock(lockFile, now);
  if (!lock) {
    await checkedHandle?.close().catch(() => undefined);
    return { status: "busy" };
  }

  let tmpFile: string | undefined;
  try {
    checkedHandle ??= await openUpdateCheck(checkedFile);
    await checkedHandle.truncate(0);
    await checkedHandle.writeFile(`${currentVersion}\n`);
    await checkedHandle.sync();
    const fetchImpl = options.fetchImpl ?? fetch;
    const releaseResponse = await fetchImpl(RELEASE_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `langsmith-cursor/${currentVersion}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!releaseResponse.ok) {
      throw new Error(`failed to check GitHub releases: HTTP ${releaseResponse.status}`);
    }

    const release = parseRelease(await releaseResponse.json());
    if (!isVersionNewer(release.tag_name, currentVersion)) return { status: "current" };
    const version = release.tag_name.replace(/^v/, "");
    const releaseTarget = getSeaReleaseTarget(runtimePlatform, runtimeArch, version);
    if (!releaseTarget) return { status: "unsupported" };
    const asset = release.assets.find((candidate) => candidate.name === releaseTarget.assetName);
    if (!asset) {
      throw new Error(`GitHub release ${release.tag_name} has no ${releaseTarget.assetName} asset`);
    }

    tmpFile = path.join(
      installDir,
      `.${EXECUTABLE_NAME}.${process.pid}.${now}.tmp${runtimePlatform === "win32" ? ".exe" : ""}`,
    );
    await downloadAsset(asset, tmpFile, fetchImpl, currentVersion, RELEASE_API);
    await fs.chmod(tmpFile, 0o755);
    const verifySignature = options.verifySignature ?? defaultSignatureVerifier(runtimePlatform);
    await verifySignature?.(tmpFile);

    if (runtimePlatform === "win32") {
      await scheduleWindowsReplacement(tmpFile, target, installDir, now);
      tmpFile = undefined;
      return { status: "scheduled", version };
    }

    await fs.rename(tmpFile, target);
    tmpFile = undefined;
    return { status: "updated", version };
  } finally {
    await checkedHandle?.close().catch(() => undefined);
    await lock.close().catch(() => undefined);
    await fs.unlink(lockFile).catch(() => undefined);
    if (tmpFile) await fs.unlink(tmpFile).catch(() => undefined);
  }
}
