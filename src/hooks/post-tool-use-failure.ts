/**
 * postToolUseFailure hook — appends a failed tool call to the current turn buffer and saves its run.
 */

import { reducePostToolUseFailure } from "../reducer.js";
import type { PostToolUseFailureInput } from "../models/types.js";
import { toolHook } from "./tool-hook.js";

export const run = toolHook<PostToolUseFailureInput>({
  describe: (input) => `postToolUseFailure ${input.tool_name} conv=${input.conversation_id}`,
  reduce: reducePostToolUseFailure,
});
