/** LangSmith run construction: one trace per turn via RunTree, threaded by conversation_id. */

import { Client, RunTree, type RunTreeConfig } from "langsmith";
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

// ─── Dotted-order helpers (exported utilities) ───────────────────────────────
// RunTree.createChild derives dotted_order; these stay for consumers that parse it.

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
  /** Image/file parts for the user message, recovered from Cursor's DB. */
  attachments?: ContentPart[];
}

/** User message as a content-part array (text first), so consumers see one format. */
function userMessageContent(prompt: string, attachments: ContentPart[]): ContentPart[] {
  const textPart: ContentPart[] =
    prompt || attachments.length === 0 ? [{ type: "text", text: prompt }] : [];
  return [...textPart, ...attachments];
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
 * LangChain-style `tool_call` content blocks for every tool the model invoked
 * this turn — direct tool calls plus subagent `Task` calls — ordered by start
 * time. Cursor doesn't expose where these interleave with assistant text, so
 * they're grouped together (before the final text in the assistant message).
 */
function assistantToolCallBlocks(buffer: TurnBuffer): Array<Record<string, unknown>> {
  const calls: Array<{ startMs: number; block: Record<string, unknown> }> = [
    ...buffer.tools.map((t) => ({
      startMs: toolStartMs(t),
      block: { type: "tool_call", name: t.name, args: t.input, id: t.tool_use_id },
    })),
    ...buffer.subagents.map((s) => ({
      startMs: s.startMs,
      block: {
        type: "tool_call",
        name: "Task",
        args: { subagent_type: s.subagent_type, task: s.task },
        id: s.subagent_id,
      },
    })),
  ];
  return calls.sort((a, b) => a.startMs - b.startMs).map((c) => c.block);
}

/** Build and submit the full LangSmith trace for one finalized turn. */
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

  // 1. Root turn run. createChild derives ids, trace_id and dotted_order for children.
  const turnName = `${TURN_RUN_NAME} ${turnNum}`;
  const turnRun = new RunTree({
    client,
    replicas,
    name: turnName,
    run_type: "chain",
    inputs: { messages: [{ role: "user", content: userContent }] },
    project_name: project,
    start_time: buffer.startMs,
    tags: DEFAULT_TAGS,
    extra: { metadata: { ...meta, turn_number: turnNum, model: buffer.model } },
  });
  await turnRun.postRun();

  // 2. llm run: usage + model/provider + assistant message. Inherits root metadata.
  //    The assistant content carries thinking, the tool_call blocks the model
  //    emitted this turn, then the final text.
  const { ls_model_name, ls_provider } = deriveModelInfo(buffer.model);
  const assistantContent: Array<Record<string, unknown>> = [
    ...buffer.thoughts.map((t) => ({ type: "thinking", thinking: t.text })),
    ...assistantToolCallBlocks(buffer),
    ...(buffer.finalText ? [{ type: "text", text: buffer.finalText }] : []),
  ];

  const llmRun = turnRun.createChild({
    name: ls_provider ?? ls_model_name,
    run_type: "llm",
    inputs: { messages: [{ role: "user", content: userContent }] },
    outputs: { messages: [{ role: "assistant", content: assistantContent }] },
    start_time: buffer.startMs,
    end_time: turnEndMs,
    extra: {
      metadata: {
        ls_provider,
        ls_model_name,
        ls_invocation_params: { model: ls_model_name },
        usage_metadata: buildUsageMetadata(buffer.usage),
      },
    },
  });
  await llmRun.postRun();

  // 3. Tool runs (siblings of the llm run, children of the turn root).
  for (const tool of buffer.tools) {
    await postToolRun(tool, turnRun);
  }

  // 4. Subagent Task runs, each nesting its own internal tool runs.
  for (const sub of buffer.subagents) {
    await postSubagentRun(sub, turnRun);
  }

  // 5. Finalize the root turn run.
  turnRun.end_time = turnEndMs;
  turnRun.outputs = { text: buffer.finalText ?? "" };
  turnRun.error = buffer.status && buffer.status !== "completed" ? buffer.status : undefined;
  await turnRun.patchRun({ excludeInputs: true });

  logger.log(
    `Traced ${turnName} (conv=${conversationId}): ${buffer.tools.length} tool(s), ${buffer.subagents.length} subagent(s)`,
  );
}

/** Post one tool run as a child of `parent` (the turn root, or a Task run). */
async function postToolRun(tool: ToolEvent, parent: RunTree): Promise<void> {
  const startMs = toolStartMs(tool);
  const isError = tool.error != null;

  const run = parent.createChild({
    name: tool.name,
    run_type: "tool",
    inputs: { input: tool.input },
    outputs: isError ? { error: tool.error } : { output: tool.output ?? "" },
    error: isError ? tool.error : undefined,
    start_time: startMs,
    end_time: tool.endMs,
    extra: {
      metadata: {
        tool_name: tool.name,
        tool_use_id: tool.tool_use_id,
        ...(tool.failure_type ? { failure_type: tool.failure_type } : {}),
      },
    },
  });
  await run.postRun();
}

/** Post the subagent's Task run, then nest its internal tool runs underneath. */
async function postSubagentRun(sub: SubagentEvent, parent: RunTree): Promise<void> {
  const isError = sub.status != null && sub.status !== "completed";
  const tools = sub.tools ?? [];

  const taskRun = parent.createChild({
    name: "Task",
    run_type: "tool",
    inputs: { subagent_type: sub.subagent_type, task: sub.task },
    outputs: {
      status: sub.status ?? "completed",
      ...(sub.resultText ? { result: sub.resultText } : {}),
    },
    error: isError ? sub.status : undefined,
    start_time: sub.startMs,
    end_time: sub.endMs ?? sub.startMs,
    extra: {
      metadata: {
        tool_name: "Task",
        subagent_id: sub.subagent_id,
        subagent_type: sub.subagent_type,
        ...(sub.childConversationId ? { subagent_conversation_id: sub.childConversationId } : {}),
        subagent_tool_count: tools.length,
      },
    },
  });
  await taskRun.postRun();

  // Nest the subagent's internal tool calls as children of the Task run.
  for (const tool of tools) {
    await postToolRun(tool, taskRun);
  }
}
