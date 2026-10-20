/** subagentStart hook — records a subagent invocation on the parent turn buffer. */

import { reduceSubagentStart } from "../reducer.js";
import type { SubagentStartInput } from "../models/types.js";
import { stateHook } from "./state-hook.js";

export const run = stateHook<SubagentStartInput>({
  describe: (input) => `subagentStart ${input.subagent_type} (${input.subagent_id})`,
  reduce: reduceSubagentStart,
});
