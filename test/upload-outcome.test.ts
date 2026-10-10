import { afterEach, describe, expect, it, vi } from "vitest";
import { initTracing, uploadTurn } from "../src/langsmith.js";
import { T0, turn } from "./utils/state.js";

const API = "https://langsmith.test/api/v1";

function answer(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: () => Promise.resolve(""),
    json: () => Promise.resolve({}),
  } as Response;
}

function serverAnswering(statusForMethod: (method: string) => number) {
  return vi.fn<typeof fetch>(async (_input, init) => answer(statusForMethod(init?.method ?? "GET")));
}

function upload(): Promise<boolean> {
  return uploadTurn({
    buffer: turn("g1", T0, { tracingMode: "full", prompt: "trace me" }),
    conversationId: "c1",
    turnNum: 1,
    project: "cursor",
  });
}

describe("shared capture is required before a turn can be settled", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not send through the SDK when shared capture context is missing", async () => {
    const request = serverAnswering(() => 202);
    vi.stubGlobal("fetch", request);
    initTracing("key", API);

    expect(await upload()).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});
