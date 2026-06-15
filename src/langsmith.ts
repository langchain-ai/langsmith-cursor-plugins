/**
 * LangSmith run construction. Builds one trace per turn via the RunTree API,
 * grouped into a thread by `thread_id` (= conversation_id).
 */

import { Client, RunTree, type RunTreeConfig, uuid7 } from "langsmith";
import type { TurnBuffer, ToolEvent, SubagentEvent, ContentPart } from "./types.js";
import { buildUsageMetadata, deriveModelInfo } from "./normalize.js";
import { LS_INTEGRATION, DEFAULT_TAGS, TURN_RUN_NAME } from "./constants.js";
import * as logger from "./logger.js";

// ─── Client setup ─────────────────────────────────────────────────────────

let client: Client | undefined = undefined;
let replicas: RunTreeConfig["replicas"] | undefined = undefined;

export function initTracing(
  apiKey?: string,
  apiUrl?: string,
  providedReplicas?: RunTreeConfig["replicas"],
  clientOverride?: Client,
): Client | undefined {
  client = clientOverride ?? (apiKey ? new Client({ apiKey, apiUrl }) : undefined);
  replicas = providedReplicas;
  return client;
}

/** Flush all pending batches so traces are sent before the hook process exits. */
export async function flushPendingTraces(): Promise<void> {
  logger.debug("Awaiting pending trace batches...");
  await Promise.all([
    client?.awaitPendingTraceBatches(),
    RunTree.getSharedClient().awaitPendingTraceBatches(),
  ]);
  logger.debug("Trace batches flushed");
}

// ─── Dotted-order helpers (ported from the Claude Code integration) ──────────

/**
 * Generate a dotted-order segment: strip(ISO_timestamp_microseconds) + runId.
 * Accepts an ISO string or milliseconds-since-epoch.
 */
export function generateDottedOrderSegment(time: string | number, runId: string): string {
  const iso = typeof time === "string" ? time : new Date(time).toISOString();
  const isoWithMicroseconds = `${iso.slice(0, -1)}000Z`;
  const stripped = isoWithMicroseconds.replace(/[-:.]/g, "");
  return stripped + runId;
}

function runIdFromSegment(segment: string): string {
  const zIdx = segment.indexOf("Z");
  return zIdx >= 0 ? segment.slice(zIdx + 1) : segment;
}

export function parseDottedOrder(dottedOrder: string): { traceId: string; runId: string } {
  const segments = dottedOrder.split(".");
  return {
    traceId: runIdFromSegment(segments[0]),
    runId: runIdFromSegment(segments[segments.length - 1]),
  };
}

// ─── Turn → run tree ─────────────────────────────────────────────────────────

export interface BuildTurnOptions {
  buffer: TurnBuffer;
  conversationId: string;
  turnNum: number;
  project: string;
  /** user_email from the hook payload, attached to runs. */
  userEmail?: string | null;
  /** Workspace roots from the hook payload. */
  workspaceRoots?: string[];
  /** Identity / repo / user metadata from config. */
  customMetadata?: Record<string, unknown>;
  /**
   * Image/file attachment parts for the user message, recovered from Cursor's DB.
   * Empty → the user message stays a plain prompt string.
   */
  attachments?: ContentPart[];
}

/**
 * Build user-message content. With attachments, return a content-part array
 * (text + image/file) for inline rendering; without, the plain prompt string.
 */
function userMessageContent(prompt: string, attachments: ContentPart[]): unknown {
  if (attachments.length === 0) return prompt;
  return [...(prompt ? [{ type: "text", text: prompt }] : []), ...attachments];
}

/** Tool start = end − duration (seconds). Clamp so start never exceeds end. */
function toolStartMs(tool: ToolEvent): number {
  const durMs = (tool.duration ?? 0) * 1000;
  return Math.max(0, tool.endMs - durMs);
}

function baseMetadata(
  conversationId: string,
  customMetadata: Record<string, unknown> | undefined,
  userEmail?: string | null,
): Record<string, unknown> {
  return {
    thread_id: conversationId,
    ls_integration: LS_INTEGRATION,
    ...(userEmail ? { user_email: userEmail } : {}),
    ...customMetadata,
  };
}

/**
 * Build and submit the full LangSmith trace for one finalized turn.
 *
 * Hierarchy:
 *   Cursor Turn N (chain, trace root)
 *   ├── <provider> (llm)   usage + model/provider, assistant text
 *   ├── tool (Read/Shell/…) one per buffered tool event
 *   └── Task (tool)         one per subagent (minimal v1)
 */
export async function buildTurnRuns(options: BuildTurnOptions): Promise<void> {
  const { buffer, conversationId, turnNum, project, userEmail, customMetadata } = options;

  if (!client && !replicas) {
    throw new Error("LangSmith client not initialized — call initTracing() first");
  }

  const meta = baseMetadata(conversationId, customMetadata, userEmail);
  const promptText = buffer.prompt ?? "";
  const userContent = userMessageContent(promptText, options.attachments ?? []);

  // Turn end = latest event time we know about, falling back to now.
  const toolEnds = buffer.tools.map((t) => t.endMs);
  const subagentEnds = buffer.subagents.map((s) => s.endMs ?? s.startMs);
  const turnEndMs = Math.max(buffer.startMs, ...toolEnds, ...subagentEnds, Date.now());

  // 1. Root turn run.
  const turnRunId = uuid7();
  const turnDottedOrder = generateDottedOrderSegment(buffer.startMs, turnRunId);
  const turnName = `${TURN_RUN_NAME} ${turnNum}`;

  const turnRun = new RunTree({
    client,
    replicas,
    id: turnRunId,
    name: turnName,
    run_type: "chain",
    // With attachments, carry the user message as content parts; else the plain prompt.
    inputs:
      (options.attachments?.length ?? 0) > 0
        ? { messages: [{ role: "user", content: userContent }] }
        : { prompt: promptText },
    project_name: project,
    start_time: buffer.startMs,
    trace_id: turnRunId,
    dotted_order: turnDottedOrder,
    tags: DEFAULT_TAGS,
    extra: { metadata: { ...meta, turn_number: turnNum, model: buffer.model } },
  });
  await turnRun.postRun();

  // 2. Synthesized llm run holding usage + model/provider + assistant text.
  const { ls_model_name, ls_provider } = deriveModelInfo(buffer.model);
  const llmRunId = uuid7();
  const llmDottedOrder = `${turnDottedOrder}.${generateDottedOrderSegment(buffer.startMs, llmRunId)}`;

  const assistantContent: Array<Record<string, unknown>> = [
    ...buffer.thoughts.map((t) => ({ type: "thinking", thinking: t.text })),
    ...(buffer.finalText ? [{ type: "text", text: buffer.finalText }] : []),
  ];

  const llmRun = new RunTree({
    client,
    replicas,
    id: llmRunId,
    name: ls_provider ?? ls_model_name,
    run_type: "llm",
    inputs: { messages: [{ role: "user", content: userContent }] },
    outputs: { messages: [{ role: "assistant", content: assistantContent }] },
    project_name: project,
    start_time: buffer.startMs,
    end_time: turnEndMs,
    parent_run_id: turnRunId,
    trace_id: turnRunId,
    dotted_order: llmDottedOrder,
    extra: {
      metadata: {
        ...meta,
        ls_provider,
        ls_model_name,
        ls_invocation_params: { model: ls_model_name },
        usage_metadata: buildUsageMetadata(buffer.usage),
      },
    },
  });
  await llmRun.postRun();

  // Children (tools + Task runs) hang off the turn root.
  const childCtx: ChildCtx = {
    parentRunId: turnRunId,
    traceId: turnRunId,
    parentDottedOrder: turnDottedOrder,
    project,
    meta,
    conversationId,
  };

  // 3. Tool runs (siblings of the llm run).
  for (const tool of buffer.tools) {
    await postToolRun(tool, childCtx);
  }

  // 4. Subagent Task runs, each nesting its own internal tool runs.
  for (const sub of buffer.subagents) {
    await postSubagentRun(sub, childCtx);
  }

  // 5. Finalize the root turn run.
  await new RunTree({
    client,
    replicas,
    id: turnRunId,
    name: turnName,
    run_type: "chain",
    project_name: project,
    start_time: buffer.startMs,
    end_time: turnEndMs,
    trace_id: turnRunId,
    dotted_order: turnDottedOrder,
    outputs: { text: buffer.finalText ?? "" },
    error: buffer.status && buffer.status !== "completed" ? buffer.status : undefined,
    extra: { metadata: { ...meta, turn_number: turnNum, model: buffer.model } },
  }).patchRun({ excludeInputs: true });

  logger.log(
    `Traced ${turnName} (conv=${conversationId}): ${buffer.tools.length} tool(s), ${buffer.subagents.length} subagent(s)`,
  );
}

interface ChildCtx {
  /** Run this child hangs off of (the turn root, or a Task run for nesting). */
  parentRunId: string;
  /** The trace root run id — constant for the whole tree, regardless of depth. */
  traceId: string;
  /** Dotted order of the parent run (child = `${parentDottedOrder}.${segment}`). */
  parentDottedOrder: string;
  project: string;
  meta: Record<string, unknown>;
  conversationId?: string;
}

async function postToolRun(tool: ToolEvent, ctx: ChildCtx): Promise<void> {
  const startMs = toolStartMs(tool);
  const runId = uuid7();
  const dottedOrder = `${ctx.parentDottedOrder}.${generateDottedOrderSegment(startMs, runId)}`;
  const isError = tool.error != null;

  await new RunTree({
    client,
    replicas,
    id: runId,
    name: tool.name,
    run_type: "tool",
    inputs: { input: tool.input },
    outputs: isError ? { error: tool.error } : { output: tool.output ?? "" },
    error: isError ? tool.error : undefined,
    project_name: ctx.project,
    start_time: startMs,
    end_time: tool.endMs,
    parent_run_id: ctx.parentRunId,
    trace_id: ctx.traceId,
    dotted_order: dottedOrder,
    extra: {
      metadata: {
        ...ctx.meta,
        tool_name: tool.name,
        tool_use_id: tool.tool_use_id,
        ...(tool.failure_type ? { failure_type: tool.failure_type } : {}),
      },
    },
  }).postRun();
}

/**
 * Post the subagent's Task run, then nest its internal tool runs underneath.
 * Output carries the subagent's final answer.
 */
async function postSubagentRun(sub: SubagentEvent, ctx: ChildCtx): Promise<void> {
  const runId = uuid7();
  const dottedOrder = `${ctx.parentDottedOrder}.${generateDottedOrderSegment(sub.startMs, runId)}`;
  const isError = sub.status != null && sub.status !== "completed";
  const tools = sub.tools ?? [];

  await new RunTree({
    client,
    replicas,
    id: runId,
    name: "Task",
    run_type: "tool",
    inputs: { subagent_type: sub.subagent_type, task: sub.task },
    outputs: {
      status: sub.status ?? "completed",
      ...(sub.resultText ? { result: sub.resultText } : {}),
    },
    error: isError ? sub.status : undefined,
    project_name: ctx.project,
    start_time: sub.startMs,
    end_time: sub.endMs ?? sub.startMs,
    parent_run_id: ctx.parentRunId,
    trace_id: ctx.traceId,
    dotted_order: dottedOrder,
    extra: {
      metadata: {
        ...ctx.meta,
        tool_name: "Task",
        subagent_id: sub.subagent_id,
        subagent_type: sub.subagent_type,
        ...(sub.childConversationId ? { subagent_conversation_id: sub.childConversationId } : {}),
        subagent_tool_count: tools.length,
      },
    },
  }).postRun();

  // Nest the subagent's internal tool calls as children of the Task run.
  const subCtx: ChildCtx = {
    parentRunId: runId,
    traceId: ctx.traceId,
    parentDottedOrder: dottedOrder,
    project: ctx.project,
    meta: ctx.meta,
    conversationId: sub.childConversationId,
  };
  for (const tool of tools) {
    await postToolRun(tool, subCtx);
  }
}
