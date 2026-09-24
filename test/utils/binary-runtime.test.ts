import { afterEach, describe, expect, it } from "vitest";

import { runningCompiledBinary } from "../../src/utils/binary-runtime.js";

const host = globalThis as { Bun?: { main?: unknown } };

afterEach(() => {
  delete host.Bun;
});

describe("runningCompiledBinary", () => {
  it("recognises the entry path Bun reports inside a compiled binary", () => {
    host.Bun = { main: "/$bunfs/root/langsmith-cursor-tracing" };
    expect(runningCompiledBinary()).toBe(true);
  });

  it("does not recognise a path that only mentions the compiled root", () => {
    host.Bun = { main: "/Users/someone/$bunfs/root/langsmith-cursor-tracing" };
    expect(runningCompiledBinary()).toBe(false);
  });

  it("does not recognise the plugin running on Node, where there is no Bun", () => {
    expect(host.Bun).toBeUndefined();
    expect(runningCompiledBinary()).toBe(false);
  });
});
