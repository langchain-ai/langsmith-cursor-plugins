import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "cursor-engine-ci-"));
const home = join(root, "home");
const temporary = join(root, "tmp");
mkdirSync(home);
mkdirSync(temporary);
const allowed = new Set(["path", "pathext", "systemroot", "windir", "comspec", "lang"]);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())));
Object.assign(env, { HOME: home, USERPROFILE: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary });
const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--reporter=dot"], { env, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
