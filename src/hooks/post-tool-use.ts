/**
 * postToolUse hook — appends a completed tool call to the current turn buffer and saves its run.
 */

import { reducePostToolUse } from "../reducer.js";
import type { PostToolUseInput } from "../models/types.js";
import { toolHook } from "./tool-hook.js";

export const run = toolHook<PostToolUseInput>({
  describe: (input) =>
    `postToolUse ${input.tool_name} conv=${input.conversation_id} gen=${input.generation_id}`,
  reduce: reducePostToolUse,
});
