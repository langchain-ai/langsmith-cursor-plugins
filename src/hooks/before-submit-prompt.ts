#!/usr/bin/env node
/**
 * beforeSubmitPrompt hook — opens a new turn buffer for this generation, OR
 * intercepts a `/langsmith` feedback command and attaches LangSmith feedback to
 * the turn the user just saw (cancelling the submission so it never reaches the
 * agent).
 */

import { readStdin } from "../utils/stdin.js";
import { initHook } from "../utils/hook-init.js";
import { atomicUpdateState, loadState } from "../state.js";
import { reduceBeforeSubmitPrompt } from "../reducer.js";
import { initTracing, submitFeedback } from "../langsmith.js";
import { parseFeedbackCommand, feedbackHelpText, type FeedbackCommand } from "../feedback.js";
import { LS_INTEGRATION } from "../constants.js";
import { error, debug } from "../logger.js";
import type { BeforeSubmitPromptInput } from "../types.js";
import type { Config } from "../config.js";

/** Cancel the submission (so the command text never reaches the agent) with a message. */
function block(userMessage: string): void {
  process.stdout.write(JSON.stringify({ continue: false, user_message: userMessage }));
}

/**
 * Post user feedback to the last finalized turn's run, then cancel the prompt.
 * Always blocks (a feedback command is never a real prompt), even on failure.
 */
async function handleFeedbackCommand(
  config: Config,
  input: BeforeSubmitPromptInput,
  command: FeedbackCommand,
): Promise<void> {
  if (command.kind === "help") {
    block(feedbackHelpText());
    return;
  }

  const lastTrace = loadState(config.stateFilePath)[input.conversation_id]?.last_trace;
  if (!lastTrace) {
    block("No recent Cursor trace to flag yet — send a message first, then run /langsmith.");
    return;
  }

  initTracing(config.apiKey, config.apiUrl, config.replicas);
  try {
    const posted = await submitFeedback(
      { runId: lastTrace.runId },
      {
        key: command.key,
        score: command.score,
        value: command.value,
        comment: command.comment,
        sourceInfo: {
          via: LS_INTEGRATION,
          conversation_id: input.conversation_id,
          turn_number: lastTrace.turnNum,
        },
      },
    );
    if (posted > 0) {
      const note = command.comment ? ` — “${command.comment}”` : "";
      block(`${command.label} recorded on Cursor Turn ${lastTrace.turnNum}${note}`);
    } else {
      block("Couldn't record feedback — LangSmith rejected the request (see hook logs).");
    }
  } catch (err) {
    error(`Feedback command failed: ${err}`);
    block("Couldn't record feedback — see hook logs.");
  }
}

async function main(): Promise<void> {
  const input = await readStdin<BeforeSubmitPromptInput>();
  const config = initHook(input.workspace_roots?.[0]);
  if (!config) return;

  const command = parseFeedbackCommand(input.prompt);
  if (command) {
    debug(`feedback command conv=${input.conversation_id} kind=${command.kind}`);
    await handleFeedbackCommand(config, input, command);
    return;
  }

  debug(`beforeSubmitPrompt conv=${input.conversation_id} gen=${input.generation_id}`);
  await atomicUpdateState(config.stateFilePath, (s) =>
    reduceBeforeSubmitPrompt(s, input, Date.now()),
  );
}

main().catch((err) => {
  try {
    error(`beforeSubmitPrompt hook error: ${err}`);
  } catch {
    /* last resort */
  }
  // Non-zero exit (never 2 = "block") tells Cursor the hook failed.
  process.exit(1);
});
