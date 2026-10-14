import { describe, expect, it, vi } from "vitest";
import { testConfig } from "./utils/state.js";

const worker = vi.hoisted(() => ({ result: "dropped", warnings: [] as string[] }));

vi.mock("@langchain/plugins-base/plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@langchain/plugins-base/plugin")>()),
  openPluginSession: () => ({ session: { drain: async () => worker.result } }),
}));
vi.mock("../src/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/logger.js")>()),
  warn: (message: string) => worker.warnings.push(message),
}));

const { runEngineWorker } = await import("../src/tracing-engine.js");

describe("the background uploader", () => {
  it.each(["dropped", "retry-exhausted", "scope-mismatch"])(
    "warns when it ends %s",
    async (result) => {
      worker.result = result;
      worker.warnings.length = 0;
      await runEngineWorker(testConfig("/nonexistent/state.json"), `conversation-${result}`);
      expect(worker.warnings).toHaveLength(1);
      expect(worker.warnings[0]).toContain(`conversation-${result}`);
    },
  );

  it("stays quiet when everything was delivered", async () => {
    worker.result = "completed";
    worker.warnings.length = 0;
    await runEngineWorker(testConfig("/nonexistent/state.json"), "conversation-completed");
    expect(worker.warnings).toEqual([]);
  });
});
