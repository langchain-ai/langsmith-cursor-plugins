import { homedir } from "node:os";
import { join } from "node:path";

import config from "../binary.config.json" with { type: "json" };
import { BINARY_INSTALL_DIRECTORY_NAME } from "./constants.js";

export function installedBinaryPath(): string {
  return join(homedir(), BINARY_INSTALL_DIRECTORY_NAME, config.executableName);
}
