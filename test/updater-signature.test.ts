import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const { execFile } = vi.hoisted(() => ({
  execFile: vi.fn((_command, _args, _options, callback) => callback(null)),
}));

vi.mock("node:child_process", () => ({ execFile }));

it("passes the macOS team requirement as inline source rather than a filename", async () => {
  vi.stubGlobal("__LS_MAC_TEAM_ID__", "ABCDEFGHIJ");
  const installDir = mkdtempSync(join(tmpdir(), "langsmith-signature-"));
  try {
    const { updateFromGitHub } = await import("../src/updater.js");
    const target = join(installDir, "langsmith-cursor-tracing");
    const binary = Buffer.from("new signed binary");
    const assetName = "langsmith-cursor-tracing-darwin-arm64-0.3.5";
    writeFileSync(target, "old binary");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          tag_name: "v0.3.5",
          assets: [
            {
              name: assetName,
              browser_download_url: `https://github.com/langchain-ai/langsmith-cursor-plugins/releases/download/v0.3.5/${assetName}`,
              size: binary.length,
              digest: `sha256:${createHash("sha256").update(binary).digest("hex")}`,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response(binary));

    await expect(
      updateFromGitHub({
        currentVersion: "0.3.4",
        installDir,
        executablePath: target,
        fetchImpl,
        runtimePlatform: "darwin",
        runtimeArch: "arm64",
      }),
    ).resolves.toEqual({ status: "updated", version: "0.3.5" });
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      "/usr/bin/codesign",
      [
        "--verify",
        "--deep",
        "--strict",
        "-R",
        "=anchor apple generic and certificate leaf[subject.OU] = ABCDEFGHIJ",
        expect.any(String),
      ],
      { timeout: 15_000 },
      expect.any(Function),
    );
    expect(readFileSync(target)).toEqual(binary);
  } finally {
    vi.unstubAllGlobals();
    rmSync(installDir, { recursive: true, force: true });
  }
});
