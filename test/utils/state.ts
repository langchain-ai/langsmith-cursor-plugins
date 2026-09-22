import type { Config } from "../../src/config.js";
import type { ConversationState, ToolEvent, TurnBuffer } from "../../src/types.js";

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
    apiUrl: "https://api.smith.langchain.com",
    project: "cursor",
    debug: false,
    stateFilePath,
    attachmentsEnabled: false,
    systemPromptEnabled: false,
    redact: true,
    sweepIdleMinutes: 60,
  };
}
