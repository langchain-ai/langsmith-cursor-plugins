import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function attemptSigning(overrides: Record<string, string>) {
  // No inherited credentials: these cases must fail before calling Apple tools.
  return spawnSync(process.execPath, ["scripts/sign-sea-release.mts"], {
    env: {
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF_TYPE: "tag",
      GITHUB_REF_NAME: "0.0.0",
      GITHUB_REPOSITORY: "langchain-ai/langsmith-cursor-plugins",
      ...overrides,
    },
    encoding: "utf-8",
  });
}

describe("production signing policy", () => {
  it.each([
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_REF_TYPE: "branch" },
    { GITHUB_REPOSITORY: "someone/fork" },
  ])("rejects an unauthorized signing context: %j", (context) => {
    const result = attemptSigning(context);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Production signing requires a release-tag push");
  });

  it.skipIf(process.platform !== "darwin")(
    "rejects a tag that differs from the package version",
    () => {
      const result = attemptSigning({});
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Release tag must match the package version");
    },
  );
});
