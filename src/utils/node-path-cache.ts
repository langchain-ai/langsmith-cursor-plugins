import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Cache at most 24 hours
export const NODE_PATH_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

interface NodePathCache {
  node_path: string;
  expire_at: string;
}

export function nodePathCacheFile(): string {
  return join(homedir(), ".cursor", "langsmith-node.json");
}

export function readCachedNodePath(
  cacheFile = nodePathCacheFile(),
  now = Date.now(),
): string | undefined {
  try {
    const cache = JSON.parse(readFileSync(cacheFile, "utf8")) as Partial<NodePathCache>;
    const expireAt = typeof cache.expire_at === "string" ? Date.parse(cache.expire_at) : NaN;
    if (
      typeof cache.node_path !== "string" ||
      !cache.node_path ||
      !Number.isFinite(expireAt) ||
      expireAt <= now ||
      expireAt > now + NODE_PATH_CACHE_TTL_MS
    ) {
      return undefined;
    }
    return cache.node_path;
  } catch {
    return undefined;
  }
}

export function isNodePathValid(
  nodePath: string,
  spawn: (command: string, args: string[]) => SpawnSyncReturns<Buffer> = spawnSync,
): boolean {
  try {
    const result = spawn(nodePath, ["--version"]);
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

export function writeCachedNodePath(
  nodePath: string,
  cacheFile = nodePathCacheFile(),
  now = Date.now(),
): void {
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    const cache: NodePathCache = {
      node_path: nodePath,
      expire_at: new Date(now + NODE_PATH_CACHE_TTL_MS).toISOString(),
    };
    writeFileSync(cacheFile, JSON.stringify(cache) + "\n", { mode: 0o600 });
  } catch {
    // Best effort: failure to cache must not prevent hook execution.
  }
}
