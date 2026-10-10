import { createHash } from "node:crypto";
import { getTurnBuffer, loadState } from "./state.js";
import { reducePostToolUse, reducePostToolUseFailure } from "./reducer.js";
import { captureCursorNativeTurnSource } from "./native-turn-source.js";
import { resolveTurnOriginRoute } from "./turn-origin.js";
import { CURSOR_EARLY_TOOL_SOURCE_EVENT_PREFIX } from "./constants.js";
import type { Config } from "./config.js";
import type { CursorEarlyToolInput } from "./models/early-tool-capture.js";
import type { CursorNativeTurnSourceResult } from "./models/native-turn-source.js";
import type { ConversationState, TracingState, TurnBuffer } from "./types.js";

export async function captureEarlyCursorToolSource(
  config: Config,
  input: CursorEarlyToolInput,
  nowMs: number,
): Promise<CursorNativeTurnSourceResult | undefined> {
  const state = loadState(config.stateFilePath);
  if (isKnownChildConversation(state, input.conversation_id)) return undefined;
  const current = getTurnBuffer(state, input.conversation_id, input.generation_id);
  if (current?.tracingMode !== "full" && current?.tracingMode !== "metadata") {
    return undefined;
  }
  const next =
    input.hook_event_name === "postToolUse"
      ? reducePostToolUse(state, input, nowMs)
      : reducePostToolUseFailure(state, input, nowMs);
  const buffer = getTurnBuffer(next, input.conversation_id, input.generation_id);
  if (!buffer || !Number.isSafeInteger(buffer.turnNum)) return undefined;
  const origin = buffer.origin;
  const { cwd, sessionId, storageRoot, destinationFingerprint } = resolveTurnOriginRoute(
    origin,
    input.session_id ?? input.conversation_id,
  );
  return captureCursorNativeTurnSource({
    storageRoot,
    accountFingerprint: destinationFingerprint,
    sessionId,
    conversationId: input.conversation_id,
    sourceEventId: earlyToolSourceEventId(input.tool_use_id),
    turnNum: buffer.turnNum!,
    buffer,
    cwd,
  });
}

function earlyToolSourceEventId(toolUseId: string): string {
  return `${CURSOR_EARLY_TOOL_SOURCE_EVENT_PREFIX}${createHash("sha256").update(toolUseId).digest("hex")}`;
}

function isKnownChildConversation(state: TracingState, conversationId: string): boolean {
  return Object.entries(state).some(
    ([parentId, conversation]) =>
      parentId !== conversationId &&
      allBuffers(conversation).some((turn) =>
        turn.subagents.some((subagent) => subagent.childConversationId === conversationId),
      ),
  );
}

function allBuffers(conversation: ConversationState): TurnBuffer[] {
  return [
    ...Object.values(conversation.turns),
    ...Object.values(conversation.pending ?? {}).map((entry) => entry.buffer),
  ];
}
