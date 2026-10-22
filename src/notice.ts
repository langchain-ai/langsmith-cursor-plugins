import { shouldShowNotice } from "@langchain/plugins-base/plugin";
import { NOTICE_PLUGIN } from "./constants.js";
import type { Config } from "./models/config.js";
import type { PromptReply } from "./models/types.js";
import { storageRootFor } from "./tracing-engine.js";

export async function noticeBlock(
  config: Config,
  kind: string,
  message: string,
): Promise<PromptReply | undefined> {
  const show = await shouldShowNotice({
    plugin: NOTICE_PLUGIN,
    kind,
    cooldown: config.noticeCooldown,
    storageRoot: storageRootFor(config),
  });
  return show ? { continue: false, user_message: message } : undefined;
}
