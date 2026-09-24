import { arch as osArch, homedir, platform as osPlatform } from "node:os";
import { dirname } from "node:path";

import { binary } from "./binary-target.js";
import { LS_INTEGRATION_VERSION } from "./config.js";
import { OLDER_THAN_ANY_RELEASE, PLUGIN_REPOSITORY_URL } from "./constants.js";
import type { CursorHooksFile, CursorHooksManifest } from "./types.js";
import { flagValue } from "./utils/argv.js";
import { runningCompiledBinary } from "./utils/binary-runtime.js";
import {
  countHooks,
  cursorHooksPath,
  mergeHooks,
  readHooksFile,
  resolveHookCommands,
  writeHooksFile,
} from "./utils/hooks-file.js";

declare const __LS_BINARY_HOOKS__: string;

function compiledHooksManifest(): CursorHooksManifest {
  const compiled = typeof __LS_BINARY_HOOKS__ === "undefined" ? undefined : __LS_BINARY_HOOKS__;
  const hooks = compiled ? (JSON.parse(compiled) as CursorHooksFile).hooks : undefined;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new Error("this build carries no hooks manifest");
  }
  return hooks;
}

export async function installBinary(args: string[]): Promise<string> {
  const platform = osPlatform();
  const arch = osArch();
  if (!binary.supportsHost(platform, arch)) {
    throw new Error(
      `no binary is published for ${platform}-${arch}. In Cursor, open Settings, then Plugins, then add ${PLUGIN_REPOSITORY_URL} instead`,
    );
  }

  const home = homedir();
  const hooksPath = cursorHooksPath(args.includes("--project") ? process.cwd() : home);
  const manifest = resolveHookCommands(compiledHooksManifest(), home);
  const contents = `${JSON.stringify(mergeHooks(await readHooksFile(hooksPath), manifest), null, 2)}\n`;
  if (args.includes("--print")) return contents;

  const tag = flagValue(args, "--tag");
  const currentVersion = LS_INTEGRATION_VERSION ?? OLDER_THAN_ANY_RELEASE;
  const installed =
    !tag && runningCompiledBinary()
      ? await binary.installLocalCopy(process.execPath, currentVersion)
      : await binary.install({ currentVersion, tag });

  await writeHooksFile(hooksPath, contents);

  return [
    `Installed ${binary.target.executableName} ${installed.version} to ${dirname(installed.path)}`,
    `Registered ${countHooks(manifest)} hooks in ${hooksPath}`,
    "",
    "Next:",
    "  1. Remove the langsmith-tracing plugin, or it traces every turn a second time.",
    `  2. Set enabled and api_key in ${dirname(hooksPath)}/langsmith.json.`,
    "  3. Fully restart Cursor so it reloads its hooks.",
  ].join("\n");
}
