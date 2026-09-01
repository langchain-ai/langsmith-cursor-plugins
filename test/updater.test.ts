import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  getSeaReleaseTarget,
  isVersionNewer,
  replaceWindowsExecutable,
  updateFromGitHub,
} from "../src/updater.js";

function digest(body: Uint8Array): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function releaseResponse(
  version: string,
  body: Uint8Array,
  overrideDigest?: string | null,
  assetName = `langsmith-cursor-tracing-darwin-arm64-${version}`,
): Response {
  const asset = {
    name: assetName,
    browser_download_url: `https://github.com/langchain-ai/langsmith-cursor-plugins/releases/download/v${version}/${assetName}`,
    size: body.byteLength,
    digest: overrideDigest === undefined ? digest(body) : overrideDigest,
  };
  return Response.json({
    tag_name: `v${version}`,
    assets: [
      asset,
      ...(overrideDigest === null
        ? [
            {
              name: `${assetName}.sha256`,
              browser_download_url: `${asset.browser_download_url}.sha256`,
              size: 74,
              digest: null,
            },
          ]
        : []),
    ],
  });
}

describe("isVersionNewer", () => {
  it("compares stable semantic versions", () => {
    expect(isVersionNewer("v0.3.5", "0.3.4")).toBe(true);
    expect(isVersionNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isVersionNewer("0.3.4", "0.3.4")).toBe(false);
    expect(isVersionNewer("0.3.3", "0.3.4")).toBe(false);
    expect(isVersionNewer("v0.4.0-beta.1", "0.3.4")).toBe(false);
  });
});

describe("getSeaReleaseTarget", () => {
  it("maps supported SEA runtimes to platform-specific release assets", () => {
    expect(getSeaReleaseTarget("darwin", "arm64", "0.3.5")).toEqual({
      assetName: "langsmith-cursor-tracing-darwin-arm64-0.3.5",
      executableName: "langsmith-cursor-tracing",
    });
    expect(getSeaReleaseTarget("linux", "x64", "v0.3.5")).toBeUndefined();
    expect(getSeaReleaseTarget("win32", "arm64", "0.3.5")).toBeUndefined();
    expect(getSeaReleaseTarget("linux", "riscv64", "0.3.5")).toBeUndefined();
    expect(getSeaReleaseTarget("freebsd", "x64", "0.3.5")).toBeUndefined();
    expect(getSeaReleaseTarget("darwin", "x64", "0.3.5")).toBeUndefined();
    expect(getSeaReleaseTarget("linux", "s390x", "0.3.5")).toBeUndefined();
  });
});

describe("updateFromGitHub", () => {
  it("downloads, verifies, and atomically replaces an installed binary", async () => {
    const installDir = mkdtempSync(join(tmpdir(), "langsmith-update-"));
    const target = join(installDir, "langsmith-cursor-tracing");
    const binary = new TextEncoder().encode("new signed binary");
    writeFileSync(target, "old binary");

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(releaseResponse("0.3.5", binary))
      .mockResolvedValueOnce(new Response(binary));
    const verifySignature = vi.fn(async (path: string) => {
      expect(readFileSync(path)).toEqual(Buffer.from(binary));
    });

    await expect(
      updateFromGitHub({
        currentVersion: "0.3.4",
        installDir,
        executablePath: target,
        fetchImpl,
        verifySignature,
        checkIntervalMs: 0,
        runtimePlatform: "darwin",
        runtimeArch: "arm64",
      }),
    ).resolves.toEqual({ status: "updated", version: "0.3.5" });
    expect(readFileSync(target)).toEqual(Buffer.from(binary));
    expect(verifySignature).toHaveBeenCalledOnce();
  });

  it("falls back to the published checksum sidecar", async () => {
    const installDir = mkdtempSync(join(tmpdir(), "langsmith-update-"));
    const target = join(installDir, "langsmith-cursor-tracing");
    const binary = new TextEncoder().encode("new binary with sidecar checksum");
    const assetName = "langsmith-cursor-tracing-darwin-arm64-0.3.5";
    writeFileSync(target, "old binary");

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(releaseResponse("0.3.5", binary, null, assetName))
      .mockResolvedValueOnce(
        new Response(`${createHash("sha256").update(binary).digest("hex")}  ${assetName}\n`),
      )
      .mockResolvedValueOnce(new Response(binary));

    await expect(
      updateFromGitHub({
        currentVersion: "0.3.4",
        installDir,
        executablePath: target,
        fetchImpl,
        verifySignature: vi.fn(),
        checkIntervalMs: 0,
        runtimePlatform: "darwin",
        runtimeArch: "arm64",
      }),
    ).resolves.toEqual({ status: "updated", version: "0.3.5" });
    expect(readFileSync(target)).toEqual(Buffer.from(binary));
  });

  it("keeps the installed binary when checksum verification fails", async () => {
    const installDir = mkdtempSync(join(tmpdir(), "langsmith-update-"));
    const target = join(installDir, "langsmith-cursor-tracing");
    const binary = new TextEncoder().encode("tampered binary");
    writeFileSync(target, "old binary");

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(releaseResponse("0.3.5", binary, `sha256:${"0".repeat(64)}`))
      .mockResolvedValueOnce(new Response(binary));

    await expect(
      updateFromGitHub({
        currentVersion: "0.3.4",
        installDir,
        executablePath: target,
        fetchImpl,
        verifySignature: vi.fn(),
        checkIntervalMs: 0,
        runtimePlatform: "darwin",
        runtimeArch: "arm64",
      }),
    ).rejects.toThrow("SHA-256 mismatch");
    expect(readFileSync(target, "utf8")).toBe("old binary");
  });

  it("keeps the installed binary when code-signature verification fails", async () => {
    const installDir = mkdtempSync(join(tmpdir(), "langsmith-update-"));
    const target = join(installDir, "langsmith-cursor-tracing");
    const binary = new TextEncoder().encode("unsigned binary");
    writeFileSync(target, "old binary");

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(releaseResponse("0.3.5", binary))
      .mockResolvedValueOnce(new Response(binary));

    await expect(
      updateFromGitHub({
        currentVersion: "0.3.4",
        installDir,
        executablePath: target,
        fetchImpl,
        verifySignature: vi.fn().mockRejectedValue(new Error("invalid signature")),
        checkIntervalMs: 0,
        runtimePlatform: "darwin",
        runtimeArch: "arm64",
      }),
    ).rejects.toThrow("invalid signature");
    expect(readFileSync(target, "utf8")).toBe("old binary");
  });

  it("does not check releases when running outside the install path", async () => {
    const installDir = mkdtempSync(join(tmpdir(), "langsmith-update-"));
    const target = join(installDir, "langsmith-cursor-tracing");
    const developmentBinary = join(installDir, "development-build");
    writeFileSync(target, "installed binary");
    writeFileSync(developmentBinary, "development binary");
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      updateFromGitHub({
        currentVersion: "0.3.4",
        installDir,
        executablePath: developmentBinary,
        fetchImpl,
        runtimePlatform: "darwin",
        runtimeArch: "arm64",
      }),
    ).resolves.toEqual({ status: "not-installed" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns not-installed when the canonical target is absent", async () => {
    const installDir = mkdtempSync(join(tmpdir(), "langsmith-update-"));
    const executablePath = join(installDir, "development-build");
    writeFileSync(executablePath, "development binary");
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      updateFromGitHub({
        currentVersion: "0.3.4",
        installDir,
        executablePath,
        fetchImpl,
        runtimePlatform: "darwin",
        runtimeArch: "arm64",
      }),
    ).resolves.toEqual({ status: "not-installed" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throttles a recent release check", async () => {
    const installDir = mkdtempSync(join(tmpdir(), "langsmith-update-"));
    const target = join(installDir, "langsmith-cursor-tracing");
    const checkedFile = join(installDir, ".last-update-check");
    const now = Date.now();
    writeFileSync(target, "installed binary");
    writeFileSync(checkedFile, "0.3.4");
    utimesSync(checkedFile, new Date(now - 1_000), new Date(now - 1_000));
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      updateFromGitHub({
        currentVersion: "0.3.4",
        installDir,
        executablePath: target,
        fetchImpl,
        now: () => now,
        checkIntervalMs: 10_000,
        runtimePlatform: "darwin",
        runtimeArch: "arm64",
      }),
    ).resolves.toEqual({ status: "throttled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns busy while another updater owns the lock", async () => {
    const installDir = mkdtempSync(join(tmpdir(), "langsmith-update-"));
    const target = join(installDir, "langsmith-cursor-tracing");
    const lockFile = join(installDir, ".update.lock");
    const now = Date.now();
    writeFileSync(target, "installed binary");
    writeFileSync(lockFile, "another updater");
    utimesSync(lockFile, new Date(now), new Date(now));
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      updateFromGitHub({
        currentVersion: "0.3.4",
        installDir,
        executablePath: target,
        fetchImpl,
        now: () => now,
        checkIntervalMs: 0,
        runtimePlatform: "darwin",
        runtimeArch: "arm64",
      }),
    ).resolves.toEqual({ status: "busy" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "recognizes an installed binary through a canonicalized path",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "langsmith-update-"));
      const installDir = join(root, "actual");
      const linkedInstallDir = join(root, "linked");
      const target = join(installDir, "langsmith-cursor-tracing");
      const binary = new TextEncoder().encode("new signed binary");
      mkdirSync(installDir);
      writeFileSync(target, "old binary", { flag: "wx" });
      symlinkSync(installDir, linkedInstallDir, "dir");

      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(releaseResponse("0.3.5", binary))
        .mockResolvedValueOnce(new Response(binary));

      await expect(
        updateFromGitHub({
          currentVersion: "0.3.4",
          installDir: linkedInstallDir,
          executablePath: target,
          fetchImpl,
          verifySignature: vi.fn(),
          checkIntervalMs: 0,
          runtimePlatform: "darwin",
          runtimeArch: "arm64",
        }),
      ).resolves.toEqual({ status: "updated", version: "0.3.5" });
      expect(readFileSync(target)).toEqual(Buffer.from(binary));
    },
  );
});

describe("replaceWindowsExecutable", () => {
  it("restores the installed executable when placing the update fails", async () => {
    const installDir = mkdtempSync(join(tmpdir(), "langsmith-update-"));
    const target = join(installDir, "langsmith-cursor-tracing.exe");
    const missingSource = join(installDir, "missing-update.exe");
    writeFileSync(target, "installed binary");

    await expect(replaceWindowsExecutable(missingSource, target, "123-456")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(readFileSync(target, "utf8")).toBe("installed binary");
    expect(readdirSync(installDir)).toEqual(["langsmith-cursor-tracing.exe"]);
  });
});
