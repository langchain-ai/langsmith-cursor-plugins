#!/usr/bin/env node
import { readStdin } from "../utils/stdin.js";
import { handlePromptSubmit } from "../prompt-control.js";
import type { BeforeSubmitPromptInput } from "../types.js";

async function main(): Promise<void> {
  const input = await readStdin<BeforeSubmitPromptInput>();
  process.stdout.write(JSON.stringify(await handlePromptSubmit(input)) + "\n");
}
main().catch(() => {
  process.stdout.write(
    JSON.stringify({
      continue: false,
      user_message: "Tracing prompt hook failed. Submission blocked; repair hooks and retry.",
    }) + "\n",
  );
});
