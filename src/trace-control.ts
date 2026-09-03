import type { TracingMode, TracingState } from "./types.js";
import { CORRUPT_STATE_KEY, enforceConversationTracing, getConversationState } from "./state.js";

export type TraceCommand = "on" | "off" | "status";

export function parseTraceCommand(prompt: string): TraceCommand | undefined {
  const match = prompt.match(/^\/trace (on|off|status)$/);
  return match?.[1] as TraceCommand | undefined;
}

export function applyTraceCommand(
  state: TracingState,
  conversationId: string,
  command: TraceCommand,
): TracingState {
  if (command === "status") return state;
  const conv = getConversationState(state, conversationId);
  if (command === "off") {
    conv.tracing = "metadata";
    enforceConversationTracing(conv);
  }
  if (command === "on") delete conv.tracing;
  conv.updated = new Date().toISOString();
  const { [CORRUPT_STATE_KEY]: _corrupt, ...recovered } = state;
  return { ...recovered, [conversationId]: conv };
}

export function tracingMode(state: TracingState, conversationId: string): TracingMode {
  return state[CORRUPT_STATE_KEY] ||
    getConversationState(state, conversationId).tracing === "metadata"
    ? "metadata"
    : "full";
}

export function traceCommandMessage(
  command: TraceCommand,
  mode: TracingMode,
  masterEnabled = true,
): string {
  if (!masterEnabled) {
    return `LangSmith tracing is disabled by the master switch. Thread preference is ${mode === "metadata" ? "off (metadata only)" : "on"}; it will apply when the master switch is enabled.`;
  }
  if (command === "off" || mode === "metadata") {
    return "LangSmith tracing is off for this thread (metadata only).";
  }
  return "LangSmith tracing is on for this thread.";
}
