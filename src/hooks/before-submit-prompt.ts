import { readStdin } from "../utils/stdin.js";
import { handlePromptSubmit } from "../prompt-control.js";
import type { BeforeSubmitPromptInput } from "../models/types.js";

export async function run(): Promise<void> {
  const input = await readStdin<BeforeSubmitPromptInput>();
  process.stdout.write(JSON.stringify(await handlePromptSubmit(input)) + "\n");
}
