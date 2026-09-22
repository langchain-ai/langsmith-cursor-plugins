import type { Config } from "./config.js";
import type { HookInputBase, TurnOrigin } from "./types.js";

export function originFromConfig(config: Config, input: HookInputBase): TurnOrigin {
  return {
    project: config.project,
    userEmail: input.user_email,
    runtimeVersion: input.cursor_version,
    customMetadata: config.customMetadata,
  };
}
