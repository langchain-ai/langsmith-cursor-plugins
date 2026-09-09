import { loadConfig } from "./config.js";
import { initLogger } from "./logger.js";
import { atomicUpdateState } from "./state.js";
import { reduceBeforeSubmitPrompt } from "./reducer.js";
import {
  getThreadTracingMode,
  parseTracingCommand,
  setThreadTracingMode,
  tracingPolicyPath,
} from "./tracing-policy.js";
import type { BeforeSubmitPromptInput } from "./types.js";

/** Synchronous command hook contract, not an LLM skill or slash-command expansion. */
export async function handlePromptSubmit(
  input: BeforeSubmitPromptInput,
): Promise<{ continue: boolean; user_message?: string }> {
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
          (!config.enabled ? " Master tracing is disabled; this does not enable it." : "") +
          (result.warning ? ` Warning: ${result.warning}` : ""),
      };
    }
    // Even master-off launches need evidence if tracing is enabled before stop.
    const enabled = config.enabled && !!(config.apiKey || config.replicas?.length);
    await atomicUpdateState(config.stateFilePath, (s) =>
      reduceBeforeSubmitPrompt(
        s,
        input,
        Date.now(),
        enabled
          ? getThreadTracingMode(tracingPolicyPath(), input.conversation_id, config.defaultMuted)
          : "off",
      ),
    );
    return { continue: true };
  } catch (error) {
    return {
      continue: false,
      user_message: `Could not save tracing preference/turn snapshot: ${error instanceof Error ? error.message : String(error)}. Submission blocked; repair local state/permissions and retry.`,
    };
  }
}
