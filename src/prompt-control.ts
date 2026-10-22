import { LOGIN_NOTICE_KIND } from "@langchain/plugins-base/auth";
import { loadConfig } from "./config.js";
import { MUTE_LOCKED_MESSAGE } from "./constants.js";
import { error as logError, initLogger } from "./logger.js";
import { noticeBlock, promptNotice } from "./notice.js";
import { atomicUpdateState } from "./state.js";
import { reduceBeforeSubmitPrompt } from "./reducer.js";
import {
  getThreadTracingMode,
  mutingLocked,
  parseTracingCommand,
  setThreadTracingMode,
  tracingPolicyPath,
} from "./tracing-policy.js";
import { originFromConfig } from "./turn-origin.js";
import { uploadCredential, uploadProblem } from "./writer-options.js";
import type { BeforeSubmitPromptInput, PromptReply } from "./models/types.js";

/** Synchronous command hook contract, not an LLM skill or slash-command expansion. */
export async function handlePromptSubmit(input: BeforeSubmitPromptInput): Promise<PromptReply> {
  const command = parseTracingCommand(input.prompt);
  try {
    if (
      !input.conversation_id ||
      typeof input.conversation_id !== "string" ||
      !input.generation_id ||
      typeof input.generation_id !== "string"
    ) {
      throw new Error("Nonempty native conversation_id and generation_id required; update Cursor");
    }
    const config = loadConfig({ cwd: input.workspace_roots?.[0] });
    initLogger(config.debug);
    if (command === "unmute" && mutingLocked(config)) {
      return { continue: false, user_message: MUTE_LOCKED_MESSAGE };
    }
    if (command) {
      const result = await setThreadTracingMode(
        tracingPolicyPath(),
        input.conversation_id,
        command === "mute" ? "metadata" : "full",
      );
      return {
        continue: false,
        user_message:
          `Thread tracing ${command === "mute" ? "muted (metadata-only)" : "unmuted (full content)"}. Preference saved for the next turn; the current turn is unchanged.` +
          (config.managedConfigProblem !== undefined
            ? ` ${config.managedConfigProblem}`
            : !config.enabled
              ? " Master tracing is disabled; this does not enable it."
              : "") +
          (result.warning ? ` Warning: ${result.warning}` : ""),
      };
    }
    // Even master-off launches need evidence if tracing is enabled before stop.
    const credential = uploadCredential(config);
    const problem = uploadProblem(config, credential);
    const enabled = config.enabled && problem === undefined;
    const mode = getThreadTracingMode(
      tracingPolicyPath(),
      input.conversation_id,
      config.defaultMuted,
      mutingLocked(config),
    );
    const notice = promptNotice(config, credential, problem);
    if (notice?.kind === LOGIN_NOTICE_KIND && config.strictAuth && mode === "full")
      return { continue: false, user_message: notice.text };
    const block = notice && (await noticeBlock(config, notice.kind, notice.text));
    if (block) return block;
    await atomicUpdateState(config.stateFilePath, (s) =>
      reduceBeforeSubmitPrompt(
        s,
        input,
        Date.now(),
        enabled ? mode : "off",
        originFromConfig(config, input),
      ),
    );
    return { continue: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logError(`Could not save tracing preference/turn snapshot: ${detail}. Turn not traced.`);
    if (command) {
      return { continue: false, user_message: `Could not save tracing preference: ${detail}` };
    }
    return { continue: true };
  }
}
