import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../../src/models/config.js";
import type {
  ConversationState,
  ToolEvent,
  TracingState,
  TurnBuffer,
} from "../../src/models/types.js";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const T0 = Date.parse("2026-08-14T09:00:00.000Z");

export function turn(
  generationId: string,
  startMs: number,
  patch: Partial<TurnBuffer> = {},
): TurnBuffer {
  return { generation_id: generationId, startMs, tools: [], thoughts: [], subagents: [], ...patch };
}

export function tool(
  toolUseId: string,
  name: string,
  endMs: number,
  input: Record<string, unknown> = {},
): ToolEvent {
  return { tool_use_id: toolUseId, name, input, endMs };
}

export function conversation(
  turns: TurnBuffer[],
  patch: Partial<ConversationState> = {},
): ConversationState {
  return {
    turns: Object.fromEntries(turns.map((t) => [t.generation_id, t])),
    turn_count: 0,
    updated: new Date(T0).toISOString(),
    ...patch,
  };
}

export function testConfig(stateFilePath: string): Config {
  return {
    enabled: true,
    defaultMuted: false,
    apiKey: "MOCK",
    apiUrl: "http://127.0.0.1",
    project: "cursor",
    debug: false,
    stateFilePath,
    attachmentsEnabled: false,
    systemPromptEnabled: false,
    redact: true,
    sweepIdleMinutes: 60,
  };
}

export function loadState(stateFilePath: string): TracingState {
  try {
    return JSON.parse(readFileSync(stateFilePath, "utf8")) as TracingState;
  } catch {
    return {};
  }
}

export function saveState(stateFilePath: string, state: TracingState): void {
  mkdirSync(dirname(stateFilePath), { recursive: true });
  writeFileSync(stateFilePath, JSON.stringify(state));
}
