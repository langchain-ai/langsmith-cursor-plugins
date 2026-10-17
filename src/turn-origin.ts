import type { Config } from "./models/config.js";
import type { HookInputBase, TurnOrigin } from "./models/types.js";

export function originFromConfig(
  config: Config,
  input: Pick<HookInputBase, "user_email" | "cursor_version">,
): TurnOrigin {
  return {
    project: config.project,
    userEmail: input.user_email,
    runtimeVersion: input.cursor_version,
    customMetadata: config.customMetadata,
  };
}
