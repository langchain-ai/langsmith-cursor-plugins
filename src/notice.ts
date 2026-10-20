import { shouldShowNotice, showDesktopNotification } from "@langchain/plugins-base/plugin";
import { NOTICE_PLUGIN, NOTICE_TITLE } from "./constants.js";
import type { Config } from "./models/config.js";
import { storageRootFor } from "./tracing-engine.js";

export async function showNotice(config: Config, kind: string, message: string): Promise<void> {
  const storageRoot = storageRootFor(config);
  if (
    await shouldShowNotice({
      plugin: NOTICE_PLUGIN,
      kind,
      cooldown: config.noticeCooldown,
      storageRoot,
    })
  )
    showDesktopNotification(NOTICE_TITLE, message);
}
