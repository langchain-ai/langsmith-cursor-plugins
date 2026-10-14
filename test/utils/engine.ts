import { spawnSync } from "node:child_process";
import { vi } from "vitest";
import { createLangSmithUploadWriter } from "@langchain/plugins-base/tracing/upload";
import { buildTurnRuns } from "../../src/langsmith.js";
import type { BuildTurnOptions } from "../../src/models/langsmith.js";
import { turnCaptures } from "../../src/captures.js";

export async function sendTurn(
  callSpy: typeof fetch,
  options: BuildTurnOptions,
  redact = true,
): Promise<void> {
  const writer = createLangSmithUploadWriter({
    destinations: [{ apiKey: "MOCK", apiUrl: "http://127.0.0.1", projectName: options.project }],
    redact,
  });
  vi.stubGlobal("fetch", callSpy);
  try {
    for (const { submission } of turnCaptures(buildTurnRuns(options))) {
      await writer.send(submission, writer.destinations[0].id);
    }
  } finally {
    vi.unstubAllGlobals();
  }
}

export async function until(done: () => boolean, ms = 30_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  return done();
}

export async function waitForWorkers(dir: string): Promise<void> {
  const running = () => spawnSync("pgrep", ["-f", dir]).status === 0;
  if (!(await until(() => !running(), 20_000))) spawnSync("pkill", ["-f", dir]);
}
