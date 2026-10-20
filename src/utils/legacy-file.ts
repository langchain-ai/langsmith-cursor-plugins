import { constants, copyFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function adoptLegacyFile(path: string, fileName: string, legacyFileName: string): void {
  if (basename(path) !== fileName || existsSync(path)) return;
  const legacy = join(dirname(path), legacyFileName);
  if (!existsSync(legacy)) return;
  try {
    copyFileSync(legacy, path, constants.COPYFILE_EXCL);
  } catch {
    return;
  }
}
