import { reduceAfterAgentThought } from "../reducer.js";
import type { AfterAgentThoughtInput } from "../models/types.js";
import { stateHook } from "./state-hook.js";

export const run = stateHook<AfterAgentThoughtInput>({
  describe: (input) => `afterAgentThought conv=${input.conversation_id} gen=${input.generation_id}`,
  reduce: reduceAfterAgentThought,
});
