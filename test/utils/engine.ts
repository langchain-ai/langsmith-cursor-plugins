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
