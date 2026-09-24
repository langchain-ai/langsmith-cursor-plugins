import { COMPILED_BINARY_ROOT } from "../constants.js";

export function runningCompiledBinary(): boolean {
  const main = (globalThis as { Bun?: { main?: unknown } }).Bun?.main;
  return typeof main === "string" && main.startsWith(COMPILED_BINARY_ROOT);
}
