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

describe("an upload is only settled when the server accepted every write", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stays unsettled when a write is refused", async () => {
    vi.stubGlobal("fetch", serverAnswering((method) => (method === "GET" ? 200 : 403)));
    initTracing("key", API);

    expect(await upload()).toBe(false);
  });

  it("stays unsettled when the request never completes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
      }),
    );
    initTracing("key", API);

    expect(await upload()).toBe(false);
  });

  it("settles on accepted writes even when the instance refuses the client's own reads", async () => {
    vi.stubGlobal("fetch", serverAnswering((method) => (method === "GET" ? 404 : 202)));
    initTracing("key", API);

    expect(await upload()).toBe(true);
  });
});
