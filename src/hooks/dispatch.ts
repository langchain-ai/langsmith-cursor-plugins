import { dispatchHookCommand } from "@langchain/plugins-base/plugin";
import { HOOK_COMMAND_OPTIONS } from "./registry.js";

await dispatchHookCommand(process.argv.slice(2), HOOK_COMMAND_OPTIONS);
