import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";

import { runningCompiledBinary } from "./utils/binary-runtime.js";
import { commandExecutable } from "./utils/command.js";
import { cursorHooksPath, readHooksFile, registeredCommands } from "./utils/hooks-file.js";
import { installedBinaryPath } from "./installed-binary.js";

async function binaryCanRun(executable: string): Promise<boolean> {
  return fs.access(executable, constants.X_OK).then(
    () => true,
    () => false,
  );
}

async function hooksFileRunsBinary(hooksFile: string, executable: string): Promise<boolean> {
  const commands = registeredCommands(await readHooksFile(hooksFile));
  return commands.some((command) => commandExecutable(command) === executable);
}

export async function pluginShouldStandDown(): Promise<boolean> {
  try {
    if (runningCompiledBinary()) return false;
    const installed = installedBinaryPath();
    if (!(await binaryCanRun(installed))) return false;
    for (const root of [process.cwd(), homedir()]) {
      if (await hooksFileRunsBinary(cursorHooksPath(root), installed)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
