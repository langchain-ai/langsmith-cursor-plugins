#!/usr/bin/env node
/**
 * beforeSubmitPrompt hook — opens a new turn buffer for this generation.
 */

import { readStdin } from "../utils/stdin.js";
import { loadConfig } from "../config.js";
import { initLogger, error, debug } from "../logger.js";
import { atomicUpdateState } from "../state.js";
import { reduceBeforeSubmitPrompt } from "../reducer.js";
import {
  applyTraceCommand,
  parseTraceCommand,
  traceCommandMessage,
  tracingMode,
} from "../trace-control.js";
import type { BeforeSubmitPromptInput, TracingMode } from "../types.js";

async function main(): Promise<void> {
  const input = await readStdin<BeforeSubmitPromptInput>();
  const config = loadConfig({ cwd: input.workspace_roots?.[0] });
  initLogger(config.debug);
  const command = parseTraceCommand(input.prompt);

  if (command) {
    let mode: TracingMode = "full";
    await atomicUpdateState(config.stateFilePath, (state) => {
      const next = applyTraceCommand(state, input.conversation_id, command);
      mode = tracingMode(next, input.conversation_id);
      return next;
    });
    process.stdout.write(
      JSON.stringify({
        continue: false,
        user_message: traceCommandMessage(command, mode, config.enabled),
      }),
    );
    return;
  }

  if (!config.enabled || (!config.apiKey && (!config.replicas || config.replicas.length === 0))) {
    return;
  }

  debug(`beforeSubmitPrompt conv=${input.conversation_id} gen=${input.generation_id}`);
  await atomicUpdateState(config.stateFilePath, (state) =>
    reduceBeforeSubmitPrompt(state, input, Date.now()),
  );
}

main().catch((err) => {
  try {
    error(`beforeSubmitPrompt hook error: ${err}`);
  } catch {}
  process.exit(1);
});
