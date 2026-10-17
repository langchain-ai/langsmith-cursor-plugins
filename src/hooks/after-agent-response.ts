/**
 * afterAgentResponse hook — records the final assistant text and per-turn usage.
 */

import { reduceAfterAgentResponse } from "../reducer.js";
import type { AfterAgentResponseInput } from "../models/types.js";
import { stateHook } from "./state-hook.js";

export const run = stateHook<AfterAgentResponseInput>({
  describe: (input) =>
    `afterAgentResponse conv=${input.conversation_id} gen=${input.generation_id}`,
  reduce: reduceAfterAgentResponse,
});
