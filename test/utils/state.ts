import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tracerPaths } from "@langchain/plugins-base/tracer";
import type { HookNote } from "@langchain/plugins-base/tracer";
import { createTranscriptBuilder } from "../../src/tracer-builder.js";
import type { Config } from "../../src/models/config.js";
import type { BuilderState } from "../../src/models/tracer-builder.js";
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
    cwd: dirname(stateFilePath),
    locked: [],
    apiUrlIsDefault: false,
    strictAuth: false,
    captureHookOutputs: false,
  };
}

export function loadNotedState(stateFilePath: string): TracingState {
  const builder = createTranscriptBuilder({
    sessionId: "notes",
    savedState: undefined,
    sink: { post: () => undefined, patch: () => undefined },
  });
  let notes: string[] = [];
  try {
    notes = readFileSync(tracerPaths(dirname(stateFilePath)).notes, "utf8").split("\n");
  } catch {
    return {};
  }
  for (const line of notes.filter(Boolean)) builder.receiveNote(JSON.parse(line) as HookNote);
  const { tracing } = builder.state() as BuilderState;
  for (const conversation of Object.values(tracing)) conversation.updated = "";
  return tracing;
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
