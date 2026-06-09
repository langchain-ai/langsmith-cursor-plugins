import { vi } from "vitest";
import { Client } from "langsmith";

type ClientParams = Exclude<ConstructorParameters<typeof Client>[0], undefined>;

/**
 * A LangSmith Client backed by a mock fetch. `callSpy.mock.calls` captures
 * every request the client (and RunTree batching) makes, so tests can
 * reconstruct the posted run tree without hitting the network.
 */
export const mockClient = (config?: Omit<ClientParams, "autoBatchTracing">) => {
  const mockFetch = vi.fn<typeof fetch>().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    text: () => Promise.resolve(""),
    json: () => Promise.resolve({}),
  } as Response);

  const client = new Client({
    ...config,
    apiKey: "MOCK",
    autoBatchTracing: false,
    fetchImplementation: mockFetch,
  });

  return { client, callSpy: mockFetch as ReturnType<typeof vi.fn> };
};
