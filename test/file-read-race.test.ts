import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCommonConfigFile } from "../src/shared-config.js";
import { getThreadTracingMode } from "../src/tracing-policy.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
}));

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("descriptor-based config reads", () => {
  it.each(["common", "policy"])(
    "reads the validated %s file even if its path is replaced",
    (kind) => {
      const dir = fs.mkdtempSync(join(tmpdir(), "config-race-"));
      dirs.push(dir);
      const path = join(dir, "config.json");
      const replacement = join(dir, "replacement.json");
      fs.writeFileSync(
        path,
        JSON.stringify(kind === "common" ? { enabled: false } : { threads: { a: "metadata" } }),
      );
      fs.writeFileSync(
        replacement,
        JSON.stringify(kind === "common" ? { enabled: true } : { threads: { a: "full" } }),
      );
      const fstat = fs.fstatSync;
      const close = vi.spyOn(fs, "closeSync");
      vi.spyOn(fs, "fstatSync").mockImplementationOnce((fd) => {
        const stat = fstat(fd);
        fs.renameSync(replacement, path);
        return stat;
      });
      if (kind === "common") {
        expect(readCommonConfigFile(path).common.enabled).toBe(false);
      } else {
        expect(getThreadTracingMode(path, "a")).toBe("metadata");
      }
      expect(close).toHaveBeenCalledTimes(1);
    },
  );
});
