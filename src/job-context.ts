import { createHash } from "node:crypto";
import { JOB_REF_PREFIX, TOOL_JOB_REF_PREFIX } from "./constants.js";
import type { QueuedJobRef, ToolJobRef, UploadJobContext } from "./models/job-context.js";
import type { TracingState, TurnOrigin } from "./models/types.js";
import {
  deleteOwnEntry,
  getConversationState,
  getTurnBuffer,
  ownEntry,
  setOwnEntry,
} from "./state.js";

export function jobDigest(sessionId: string, context: UploadJobContext): string {
  const { kind, buffer, toolIndex } = context;
  const toolUseId = toolIndex === undefined ? null : buffer.tools[toolIndex]?.tool_use_id;
  return createHash("sha256")
    .update(JSON.stringify([sessionId, kind, buffer.generation_id, toolIndex ?? null, toolUseId]))
    .digest("hex");
}

export function jobRef(ref: QueuedJobRef): string {
  const value = [ref.conversationId, ref.generationId, ref.savedAtMs];
  return `${JOB_REF_PREFIX}${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}

export function parseJobRef(ref: string | undefined): QueuedJobRef | undefined {
  if (!ref?.startsWith(JOB_REF_PREFIX)) return undefined;
  try {
    const [conversationId, generationId, savedAtMs] = JSON.parse(
      Buffer.from(ref.slice(JOB_REF_PREFIX.length), "base64url").toString("utf8"),
    );
    return { conversationId, generationId, savedAtMs };
  } catch {
    return undefined;
  }
}

export function queuedContext(
  state: TracingState,
  ref: QueuedJobRef,
): UploadJobContext | undefined {
  const queued = ownEntry(ownEntry(state, ref.conversationId)?.queued, ref.generationId);
  return queued?.savedAtMs === ref.savedAtMs ? queued : undefined;
}

export function reduceTypedSkill(
  state: TracingState,
  conversationId: string,
  generationId: string,
  typedSkill: string | null | undefined,
): TracingState {
  const turn = getTurnBuffer(state, conversationId, generationId);
  if (turn) turn.typedSkill = typedSkill;
  return state;
}

export function reduceQueued(
  state: TracingState,
  context: UploadJobContext,
  savedAtMs: number,
): TracingState {
  const conv = getConversationState(state, context.conversationId);
  conv.updated ||= new Date(savedAtMs).toISOString();
  setOwnEntry((conv.queued ??= {}), context.buffer.generation_id, { ...context, savedAtMs });
  return { ...state, [context.conversationId]: conv };
}

export function reduceChosenOutputs(
  state: TracingState,
  ref: QueuedJobRef,
  outputEventIds: string[],
): TracingState {
  const queued = queuedContext(state, ref);
  if (!queued) return state;
  queued.outputEventIds = outputEventIds;
  return { ...state };
}

export function reduceUploaded(state: TracingState, refs: Iterable<QueuedJobRef>): TracingState {
  for (const ref of refs) {
    const conv = ownEntry(state, ref.conversationId);
    if (!conv?.queued || !queuedContext(state, ref)) continue;
    deleteOwnEntry(conv.queued, ref.generationId);
    if (Object.keys(conv.queued).length === 0) delete conv.queued;
  }
  return { ...state };
}

export function finishedJobRefs(
  built: ReadonlyMap<string, string>,
  pendingEventIds: ReadonlySet<string>,
): QueuedJobRef[] {
  return [...built]
    .filter(([eventId]) => !pendingEventIds.has(eventId))
    .flatMap(([, ref]) => parseJobRef(ref) ?? []);
}

export function toolJobRef(ref: ToolJobRef): string {
  const { conversationId, generationId, toolIndex, toolUseId, model, withRoot } = ref;
  const value = [conversationId, generationId, toolIndex, toolUseId, model ?? null, withRoot];
  return `${TOOL_JOB_REF_PREFIX}${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}

export function parseToolJobRef(ref: string | undefined): ToolJobRef | undefined {
  if (!ref?.startsWith(TOOL_JOB_REF_PREFIX)) return undefined;
  try {
    const [conversationId, generationId, toolIndex, toolUseId, model, withRoot] = JSON.parse(
      Buffer.from(ref.slice(TOOL_JOB_REF_PREFIX.length), "base64url").toString("utf8"),
    );
    return {
      conversationId,
      generationId,
      toolIndex,
      toolUseId,
      model: model ?? undefined,
      withRoot,
    };
  } catch {
    return undefined;
  }
}

export function toolJobContext(
  state: TracingState,
  ref: ToolJobRef,
  fallbackOrigin: TurnOrigin,
): UploadJobContext | undefined {
  const conv = ownEntry(state, ref.conversationId);
  const buffer =
    getTurnBuffer(state, ref.conversationId, ref.generationId) ??
    ownEntry(conv?.pending, ref.generationId)?.buffer ??
    ownEntry(conv?.queued, ref.generationId)?.buffer;
  if (buffer?.tools[ref.toolIndex]?.tool_use_id !== ref.toolUseId) return undefined;
  return {
    kind: "tool",
    conversationId: ref.conversationId,
    turnNum: buffer.turnNum ?? 0,
    buffer: { ...buffer, model: ref.model },
    origin: buffer.origin ?? fallbackOrigin,
    toolIndex: ref.toolIndex,
  };
}
