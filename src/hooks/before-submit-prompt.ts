#!/usr/bin/env node
import { readStdin } from "../utils/stdin.js";
import { handlePromptSubmit } from "../prompt-control.js";
import type { BeforeSubmitPromptInput } from "../types.js";

async function main(): Promise<void> {
  const input = await readStdin<BeforeSubmitPromptInput>();
  process.stdout.write(JSON.stringify(await handlePromptSubmit(input)) + "\n");
}
main().catch((err: unknown) => {
  console.error(`[langsmith] prompt hook failed: ${String(err)}. This turn is not traced.`);
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
});
