import { binary } from "./binary-target.js";
import { LS_INTEGRATION_VERSION } from "./config.js";
import { OLDER_THAN_ANY_RELEASE } from "./constants.js";
import type { BinaryUpdateResult } from "./types.js";

export async function updateInstalledBinary(): Promise<BinaryUpdateResult> {
  if (!(await binary.isInstalledBinary(process.execPath))) return { status: "not-installed" };

  return binary.update({ currentVersion: LS_INTEGRATION_VERSION ?? OLDER_THAN_ANY_RELEASE });
}

export function describeUpdate(result: BinaryUpdateResult): string {
  switch (result.status) {
    case "updated":
      return `Updated ${binary.target.executableName} to ${result.version}`;
    case "current":
      return `${binary.target.executableName} is already the newest release`;
    case "busy":
      return "Another update is already running";
    case "unsupported":
      return "No release is published for this machine";
    case "not-installed":
      return `${process.execPath} is not the installed binary, so nothing was updated`;
  }
}
