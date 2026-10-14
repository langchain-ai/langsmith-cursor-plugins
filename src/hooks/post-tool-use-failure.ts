/**
 * postToolUseFailure hook — appends a failed tool call to the current turn buffer.
 */

import { reducePostToolUseFailure } from "../reducer.js";
import type { PostToolUseFailureInput } from "../models/types.js";
import { stateHook } from "./state-hook.js";

export const run = stateHook<PostToolUseFailureInput>({
  describe: (input) => `postToolUseFailure ${input.tool_name} conv=${input.conversation_id}`,
  reduce: reducePostToolUseFailure,
});
