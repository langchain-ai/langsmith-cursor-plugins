import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("initializes logging in the background updater when tracing is disabled", () => {
  const testHome = mkdtempSync(join(tmpdir(), "langsmith-sea-"));
  const logFile = join(testHome, ".cursor", "langsmith-hook.log");
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(new URL("../src/sea.ts", import.meta.url)),
        "--background-update",
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        cwd: testHome,
        env: {
          ...process.env,
          HOME: testHome,
          USERPROFILE: testHome,
          TRACE_TO_LANGSMITH: "false",
          LANGSMITH_CURSOR_DEBUG: "true",
          LANGSMITH_CURSOR_INTEGRATION_VERSION: "",
          LANGSMITH_CURSOR_LOG_FILE: logFile,
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(logFile, "utf8")).toContain("Automatic update result: current");
  } finally {
    rmSync(testHome, { recursive: true, force: true });
  }
});
