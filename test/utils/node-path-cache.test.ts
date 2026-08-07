import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isNodePathValid,
  NODE_PATH_CACHE_TTL_MS,
  readCachedNodePath,
  writeCachedNodePath,
} from "../../src/utils/node-path-cache.js";

const NOW = Date.parse("2026-08-07T12:00:00.000Z");

function cacheFile(): string {
  return join(
    mkdtempSync(join(tmpdir(), "langsmith-node-cache-")),
    ".cursor",
    "langsmith-node.json",
  );
}

describe("node path cache", () => {
  type SpawnSync = typeof import("node:child_process").spawnSync;

  it("stores the node path with an expiration one day later", () => {
    const file = cacheFile();
    writeCachedNodePath("/opt/node/bin/node", file, NOW);

    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      node_path: "/opt/node/bin/node",
      expire_at: new Date(NOW + NODE_PATH_CACHE_TTL_MS).toISOString(),
    });
    expect(readCachedNodePath(file, NOW)).toBe("/opt/node/bin/node");
  });

  it("ignores expired entries and entries lasting longer than a day", () => {
    const file = cacheFile();
    writeCachedNodePath("/opt/node/bin/node", file, NOW);
    writeFileSync(
      file,
      JSON.stringify({ node_path: "/expired/node", expire_at: new Date(NOW).toISOString() }),
    );
    expect(readCachedNodePath(file, NOW)).toBeUndefined();

    writeFileSync(
      file,
      JSON.stringify({
        node_path: "/long-lived/node",
        expire_at: new Date(NOW + NODE_PATH_CACHE_TTL_MS + 1).toISOString(),
      }),
    );
    expect(readCachedNodePath(file, NOW)).toBeUndefined();
  });

  it("ignores missing or malformed cache files", () => {
    const file = cacheFile();
    expect(readCachedNodePath(file, NOW)).toBeUndefined();
    writeCachedNodePath("/opt/node/bin/node", file, NOW);
    writeFileSync(file, "not json");
    expect(readCachedNodePath(file, NOW)).toBeUndefined();
  });

  it("validates a cached path by spawning node --version", () => {
    const calls: Array<[string, string[]]> = [];
    const spawn = ((command: string, args: string[]) => {
      calls.push([command, args]);
      return { error: undefined, status: 0 };
    }) as SpawnSync;

    expect(isNodePathValid("/opt/node/bin/node", spawn)).toBe(true);
    expect(calls).toEqual([["/opt/node/bin/node", ["--version"]]]);
  });

  it("rejects cached paths that cannot be spawned successfully", () => {
    const failed = (() => ({
      error: new Error("spawn failed"),
      status: null,
    })) as unknown as SpawnSync;

    const nonzero = (() =>
      ({ error: undefined, status: 1 }) as ReturnType<
        typeof import("node:child_process").spawnSync
      >) as unknown as SpawnSync;

    expect(isNodePathValid("/missing/node", failed)).toBe(false);
    expect(isNodePathValid("/broken/node", nonzero)).toBe(false);
    expect(
      isNodePathValid("/throwing/node", () => {
        throw new Error("spawn threw");
      }),
    ).toBe(false);
  });
});
