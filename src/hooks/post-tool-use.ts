/**
 * postToolUse hook — appends a completed tool call to the current turn buffer.
 */

import { reducePostToolUse } from "../reducer.js";
import type { PostToolUseInput } from "../models/types.js";
import { stateHook } from "./state-hook.js";

export const run = stateHook<PostToolUseInput>({
  describe: (input) =>
    `postToolUse ${input.tool_name} conv=${input.conversation_id} gen=${input.generation_id}`,
  reduce: reducePostToolUse,
});
