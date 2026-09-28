import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { readHooksFile } from "../../src/utils/hooks-file.js";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cursor-hooks-file-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

it("names the file and says what to do when it holds no valid JSON", async () => {
  for (const body of ["", "{oops"]) {
    const path = join(directory, "hooks.json");
    writeFileSync(path, body);
    await expect(readHooksFile(path), JSON.stringify(body)).rejects.toThrow(
      `${path} is not valid JSON. Repair or delete it, then try again.`,
    );
  }
});
