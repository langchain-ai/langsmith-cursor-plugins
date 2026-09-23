import * as fs from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  CURSOR_DIRECTORY_NAME,
  CURSOR_HOOKS_FILE_NAME,
  CURSOR_HOOKS_VERSION,
  HOME_PLACEHOLDER,
} from "../constants.js";
import type { CursorHooksFile, CursorHooksManifest } from "../types.js";

export function cursorHooksPath(root: string): string {
  return join(root, CURSOR_DIRECTORY_NAME, CURSOR_HOOKS_FILE_NAME);
}

export function resolveHookCommands(
  manifest: CursorHooksManifest,
  home: string,
): CursorHooksManifest {
  return Object.fromEntries(
    Object.entries(manifest).map(([event, hooks]) => [
      event,
      hooks.map((hook) =>
        typeof hook.command === "string"
          ? { ...hook, command: hook.command.split(HOME_PLACEHOLDER).join(home) }
          : hook,
      ),
    ]),
  );
}

export function mergeHooks(
  existing: CursorHooksFile,
  manifest: CursorHooksManifest,
): CursorHooksFile {
  const merged: CursorHooksManifest = { ...existing.hooks };
  for (const [event, hooks] of Object.entries(manifest)) {
    const kept = (merged[event] ?? []).filter(
      (hook) => !hooks.some((ours) => ours.command === hook.command),
    );
    merged[event] = [...kept, ...hooks];
  }
  return { version: existing.version ?? CURSOR_HOOKS_VERSION, hooks: merged };
}

export function countHooks(manifest: CursorHooksManifest): number {
  return Object.values(manifest).reduce((total, hooks) => total + hooks.length, 0);
}

export async function readHooksFile(path: string): Promise<CursorHooksFile> {
  return fs.readFile(path, "utf-8").then(
    (text) => JSON.parse(text) as CursorHooksFile,
    () => ({}),
  );
}

export async function writeHooksFile(path: string, contents: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const mode = await fs.stat(path).then(
    (stats) => stats.mode & 0o777,
    () => 0o600,
  );
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(temporary, contents, { mode: 0o600 });
    await fs.chmod(temporary, mode);
    await fs.rename(temporary, path);
  } catch (err) {
    await fs.unlink(temporary).catch(() => undefined);
    throw err;
  }
}
