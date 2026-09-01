import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
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
  overrideDigest?: string,
  assetName = `langsmith-cursor-tracing-darwin-arm64-${version}`,
): Response {
  return Response.json({
    tag_name: `v${version}`,
    assets: [
      {
        name: assetName,
        browser_download_url: `https://github.com/langchain-ai/langsmith-cursor-plugins/releases/download/v${version}/${assetName}`,
        size: body.byteLength,
        digest: overrideDigest ?? digest(body),
      },
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
    expect(getSeaReleaseTarget("linux", "x64", "v0.3.5")).toEqual({
      assetName: "langsmith-cursor-tracing-linux-x64-0.3.5",
      executableName: "langsmith-cursor-tracing",
    });
    expect(getSeaReleaseTarget("win32", "arm64", "0.3.5")).toEqual({
      assetName: "langsmith-cursor-tracing-win32-arm64-0.3.5.exe",
      executableName: "langsmith-cursor-tracing.exe",
    });
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

  it("selects and installs the matching Linux asset", async () => {
    const installDir = mkdtempSync(join(tmpdir(), "langsmith-update-"));
    const target = join(installDir, "langsmith-cursor-tracing");
    const binary = new TextEncoder().encode("new Linux binary");
    const assetName = "langsmith-cursor-tracing-linux-x64-0.3.5";
    writeFileSync(target, "old binary");

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(releaseResponse("0.3.5", binary, undefined, assetName))
      .mockResolvedValueOnce(new Response(binary));

    await expect(
      updateFromGitHub({
        currentVersion: "0.3.4",
        installDir,
        executablePath: target,
        fetchImpl,
        checkIntervalMs: 0,
        runtimePlatform: "linux",
        runtimeArch: "x64",
      }),
    ).resolves.toEqual({ status: "updated", version: "0.3.5" });
    expect(readFileSync(target)).toEqual(Buffer.from(binary));
  });

  it("replaces a Windows executable without launching a script", async () => {
    const installDir = mkdtempSync(join(tmpdir(), "langsmith-update-"));
    const target = join(installDir, "langsmith-cursor-tracing.exe");
    const binary = new TextEncoder().encode("new Windows binary");
    const assetName = "langsmith-cursor-tracing-win32-x64-0.3.5.exe";
    writeFileSync(target, "old Windows binary");

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(releaseResponse("0.3.5", binary, undefined, assetName))
      .mockResolvedValueOnce(new Response(binary));

    await expect(
      updateFromGitHub({
        currentVersion: "0.3.4",
        installDir,
        executablePath: target,
        fetchImpl,
        checkIntervalMs: 0,
        runtimePlatform: "win32",
        runtimeArch: "x64",
        now: () => 1234,
      }),
    ).resolves.toEqual({ status: "updated", version: "0.3.5" });
    expect(readFileSync(target)).toEqual(Buffer.from(binary));
    expect(
      readFileSync(
        join(installDir, `.langsmith-cursor-tracing.old-${process.pid}-1234.exe`),
        "utf8",
      ),
    ).toBe("old Windows binary");
  });

  it("only cleans up updater-owned Windows replacement files", async () => {
    const installDir = mkdtempSync(join(tmpdir(), "langsmith-update-"));
    const target = join(installDir, "langsmith-cursor-tracing.exe");
    const oldExecutable = join(installDir, ".langsmith-cursor-tracing.old-123-456.exe");
    const unrelatedFile = join(installDir, ".langsmith-cursor-tracing.old-custom.exe");
    writeFileSync(target, "installed binary");
    writeFileSync(oldExecutable, "old binary");
    writeFileSync(unrelatedFile, "unrelated");

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(releaseResponse("0.3.5", new Uint8Array([1])));

    await expect(
      updateFromGitHub({
        currentVersion: "0.3.5",
        installDir,
        executablePath: target,
        fetchImpl,
        checkIntervalMs: 0,
        runtimePlatform: "win32",
        runtimeArch: "x64",
      }),
    ).resolves.toEqual({ status: "current" });
    expect(readdirSync(installDir)).not.toContain(".langsmith-cursor-tracing.old-123-456.exe");
    expect(readFileSync(unrelatedFile, "utf8")).toBe("unrelated");
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
