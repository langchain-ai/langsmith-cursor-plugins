import { readPolicyFile, updatePolicyFile } from "@langchain/plugins-base/plugin";
import type { PolicyFileOptions } from "@langchain/plugins-base/plugin";
import { homedir } from "node:os";
import { join } from "node:path";
import { LEGACY_TRACING_POLICY_FILE_NAME, TRACING_POLICY_FILE_NAME } from "./constants.js";
import type { TracingPolicy } from "./models/tracing-policy.js";
import { adoptLegacyFile } from "./utils/legacy-file.js";
import { isRecord } from "./normalize.js";
import type { Config } from "./models/config.js";
import type { TracingMode, TurnBuffer } from "./models/types.js";

function isMode(value: unknown): value is TracingMode {
  return value === "full" || value === "metadata";
}

const TRACING_POLICY_FILE: PolicyFileOptions<TracingPolicy> = {
  empty: () => ({ threads: {} }),
  requireRegularFile: true,
  parse(value) {
    if (
      !isRecord(value) ||
      !isRecord(value.threads) ||
      Object.values(value.threads).some((mode) => !isMode(mode)) ||
      Object.keys(value).some((key) => key !== "threads")
    ) {
      throw new Error("Invalid tracing preference format");
    }
    return value as unknown as TracingPolicy;
  },
};

export function tracingPolicyPath(): string {
  return (
    process.env.LANGSMITH_CURSOR_PRIVACY_FILE ??
    join(homedir(), ".cursor", TRACING_POLICY_FILE_NAME)
  );
}

export function mutingLocked(config: Pick<Config, "defaultMuted" | "locked">): boolean {
  return config.defaultMuted && config.locked.includes("defaultMuted");
}

export function withLockedMute(
  buffer: TurnBuffer,
  config: Pick<Config, "defaultMuted" | "locked">,
): TurnBuffer {
  return mutingLocked(config) && buffer.tracingMode === "full"
    ? { ...buffer, tracingMode: "metadata" }
    : buffer;
}

export function getThreadTracingMode(
  path: string,
  sessionId: string,
  defaultMuted = false,
  mutedLocked = false,
): TracingMode {
  if (mutedLocked) return "metadata";
  try {
    adoptLegacyFile(path, TRACING_POLICY_FILE_NAME, LEGACY_TRACING_POLICY_FILE_NAME);
    const policy = readPolicyFile(path, TRACING_POLICY_FILE);
    if (Object.hasOwn(policy.threads, sessionId)) return policy.threads[sessionId];
    return defaultMuted ? "metadata" : "full";
  } catch {
    return "metadata";
  }
}

/** Exact, argument-free commands only; ordinary prompts are never interpreted. */
export function parseTracingCommand(prompt: string): "mute" | "unmute" | undefined {
  if (prompt === "langsmith-tracing:mute") return "mute";
  if (prompt === "langsmith-tracing:unmute") return "unmute";
  return undefined;
}

/**
 * Independent of tracing state and its pruning. Writers serialize through an
 * exclusive directory lock (mkdir avoids O_EXCL's network-filesystem caveats).
 * No age/PID-based stealing: even a slow live writer is safe.
 * A crashed writer's lock requires explicit removal after confirming it is idle.
 * Rename commits the effective preference. Later durability/cleanup failures are
 * returned as local warnings, not thrown as if the preference were unchanged.
 */
export async function setThreadTracingMode(
  path: string,
  sessionId: string,
  mode: TracingMode,
): Promise<{ warning?: string }> {
  if (typeof sessionId !== "string" || !sessionId || !isMode(mode)) {
    throw new Error("A nonempty session ID and a full/metadata tracing mode are required");
  }
  adoptLegacyFile(path, TRACING_POLICY_FILE_NAME, LEGACY_TRACING_POLICY_FILE_NAME);
  // Computed property + spread handle session IDs such as "__proto__" safely.
  return updatePolicyFile(path, TRACING_POLICY_FILE, (policy) => ({
    threads: { ...policy.threads, [sessionId]: mode },
  }));
}
