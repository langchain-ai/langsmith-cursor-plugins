/** LangSmith run construction: one trace per turn via RunTree, threaded by conversation_id. */

import { Client, RunTree, type RunTreeConfig } from "langsmith";
import type { TurnBuffer, ToolEvent, SubagentEvent, ContentPart } from "./types.js";
import { buildUsageMetadata, deriveModelInfo } from "./normalize.js";
import { DEFAULT_TAGS, TURN_RUN_NAME } from "./constants.js";
import { codingAgentMetadata } from "./metadata.js";
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
  /** coding-agent-v1 base metadata from config (repo/git/cwd/user/version). */
  customMetadata?: Record<string, unknown>;
  /** Cursor runtime version (hook `cursor_version`) → ls_agent_runtime_version. */
  runtimeVersion?: string;
  /** Image/file parts for the user message, recovered from Cursor's DB. */
  attachments?: ContentPart[];
  /** The turn's system prompt, recovered from Cursor's DB (prepended to llm runs). */
  systemPrompt?: string;
}

/** Per-turn context shared by every run's coding-agent-v1 metadata. */
interface MetaCtx {
  threadId: string;
  base?: Record<string, unknown>;
  turnId?: string;
  turnNumber?: number;
  runtimeVersion?: string;
}

/** Prepend a system message to an llm run's input messages, when one was recovered. */
function withSystem(
  messages: Array<Record<string, unknown>>,
  systemPrompt: string | undefined,
): Array<Record<string, unknown>> {
  return systemPrompt ? [{ role: "system", content: systemPrompt }, ...messages] : messages;
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

interface TurnCall {
  startMs: number;
  /** LangChain `tool_call` content block for the assistant message. */
  toolCallBlock: Record<string, unknown>;
  /** Tool-result message fed back into the final llm run's input. */
  resultMessage: Record<string, unknown>;
}

/** Render a tool's output (or error) as text for a tool-result message. */
function toolResultText(tool: ToolEvent): string {
  if (tool.error != null) return tool.error;
  const out = tool.output;
  if (out == null) return "";
  return typeof out === "string" ? out : JSON.stringify(out);
}

/** One tool event → its ordered TurnCall (tool_call block + tool-result message). */
function toolCall(t: ToolEvent, floorMs: number): TurnCall {
  return {
    startMs: Math.max(floorMs, toolStartMs(t)),
    toolCallBlock: { type: "tool_call", name: t.name, args: t.input, id: t.tool_use_id },
    resultMessage: {
      role: "tool",
      tool_call_id: t.tool_use_id,
      content: [{ type: "text", text: toolResultText(t) }],
    },
  };
}

/** Tool/subagent calls this turn, ordered by start, each paired with its result message. */
function orderedTurnCalls(buffer: TurnBuffer): TurnCall[] {
  const calls: TurnCall[] = [
    ...buffer.tools.map((t) => toolCall(t, buffer.startMs)),
    ...buffer.subagents.map((s) => ({
      startMs: s.startMs,
      toolCallBlock: {
        type: "tool_call",
        name: "Subagent",
        args: { subagent_type: s.subagent_type, task: s.task },
        id: s.subagent_id,
      },
      resultMessage: {
        role: "tool",
        tool_call_id: s.subagent_id,
        content: [{ type: "text", text: s.resultText ?? `status: ${s.status ?? "completed"}` }],
      },
    })),
  ];
  return calls.sort((a, b) => a.startMs - b.startMs);
}

/** Build and submit the full LangSmith trace for one finalized turn. */
export async function buildTurnRuns(options: BuildTurnOptions): Promise<void> {
  const { buffer, conversationId, turnNum, project, userEmail, customMetadata, systemPrompt } =
    options;

  if (!client && !replicas) {
    throw new Error("LangSmith client not initialized — call initTracing() first");
  }

  // coding-agent-v1 context, stamped on the root and propagated to children
  // via createChild. user_email (per-turn) joins the config base.
  const ctx: MetaCtx = {
    threadId: conversationId,
    base: { ...customMetadata, ...(userEmail ? { user_email: userEmail } : {}) },
    turnId: buffer.generation_id,
    turnNumber: turnNum,
    runtimeVersion: options.runtimeVersion,
  };
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
    extra: { metadata: codingAgentMetadata({ ...ctx, runSpecific: { model: buffer.model } }) },
  });
  await turnRun.postRun();

  // 2. llm + tool runs, created in invocation order. Turn-level usage goes on one llm run.
  const { ls_model_name, ls_provider } = deriveModelInfo(buffer.model);
  const llmName = ls_provider ?? ls_model_name;
  const llmMeta = {
    ls_provider,
    ls_model_name,
    ls_invocation_params: { model: ls_model_name },
  };
  const usageMetadata = buildUsageMetadata(buffer.usage);
  const thinking = buffer.thoughts.map((t) => ({ type: "thinking", thinking: t.text }));
  const finalTextBlocks = buffer.finalText ? [{ type: "text", text: buffer.finalText }] : [];
  const calls = orderedTurnCalls(buffer);

  if (calls.length === 0) {
    // No tools: a single llm run, user → assistant (thinking + final text).
    const llmRun = turnRun.createChild({
      name: llmName,
      run_type: "llm",
      inputs: { messages: withSystem([{ role: "user", content: userContent }], systemPrompt) },
      outputs: { messages: [{ role: "assistant", content: [...thinking, ...finalTextBlocks] }] },
      start_time: buffer.startMs,
      end_time: turnEndMs,
      extra: {
        metadata: codingAgentMetadata({
          ...ctx,
          runSpecific: { ...llmMeta, usage_metadata: usageMetadata },
        }),
      },
    });
    await llmRun.postRun();
  } else {
    // Agentic turn: "decide" llm → tool runs → "answer" llm fed the results.
    const firstCallStart = Math.min(...calls.map((c) => c.startMs));
    const lastCallEnd = Math.max(
      buffer.startMs,
      ...buffer.tools.map((t) => t.endMs),
      ...buffer.subagents.map((s) => s.endMs ?? s.startMs),
    );
    const assistantDecision = [...thinking, ...calls.map((c) => c.toolCallBlock)];

    // 2a. "decide" llm — emits the tool calls. Usage goes on the answer run.
    const decideRun = turnRun.createChild({
      name: llmName,
      run_type: "llm",
      inputs: { messages: withSystem([{ role: "user", content: userContent }], systemPrompt) },
      outputs: { messages: [{ role: "assistant", content: assistantDecision }] },
      start_time: buffer.startMs,
      end_time: Math.max(buffer.startMs, firstCallStart),
      extra: { metadata: codingAgentMetadata({ ...ctx, runSpecific: { ...llmMeta } }) },
    });
    await decideRun.postRun();

    // 3. Tool runs (and subagent Task runs) between the two llm calls.
    for (const tool of buffer.tools) await postToolRun(tool, turnRun, ctx);
    for (const sub of buffer.subagents) await postSubagentRun(sub, turnRun, ctx);

    // 2b. "answer" llm — tool results fed back in, produces the final text.
    const answerRun = turnRun.createChild({
      name: llmName,
      run_type: "llm",
      inputs: {
        messages: withSystem(
          [
            { role: "user", content: userContent },
            { role: "assistant", content: assistantDecision },
            ...calls.map((c) => c.resultMessage),
          ],
          systemPrompt,
        ),
      },
      outputs: { messages: [{ role: "assistant", content: finalTextBlocks }] },
      start_time: lastCallEnd,
      end_time: turnEndMs,
      extra: {
        metadata: codingAgentMetadata({
          ...ctx,
          runSpecific: { ...llmMeta, usage_metadata: usageMetadata },
        }),
      },
    });
    await answerRun.postRun();
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

/** Post one tool run under `parent`. `clearSubagent` neutralizes inherited subagent keys. */
async function postToolRun(
  tool: ToolEvent,
  parent: RunTree,
  ctx: MetaCtx,
  clearSubagent = false,
): Promise<void> {
  // Clamp start to the parent's — Cursor tool durations can exceed the turn,
  // mis-sorting tools ahead of the llm.
  const floorMs = typeof parent.start_time === "number" ? parent.start_time : 0;
  const startMs = Math.max(floorMs, toolStartMs(tool));
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
      metadata: codingAgentMetadata({
        ...ctx,
        clearSubagent,
        // run name == native tool name, so ls_tool_name is omitted; tool_name kept as alias.
        toolName: tool.name,
        runName: tool.name,
        runSpecific: {
          tool_name: tool.name,
          tool_use_id: tool.tool_use_id,
          ...(tool.failure_type ? { failure_type: tool.failure_type } : {}),
        },
      }),
    },
  });
  await run.postRun();
}

async function postSubagentRun(sub: SubagentEvent, parent: RunTree, ctx: MetaCtx): Promise<void> {
  const isError = sub.status != null && sub.status !== "completed";
  const tools = sub.tools ?? [];
  const startMs = sub.startMs;
  const endMs = sub.endMs ?? sub.startMs;

  // Name the node "<type> Subagent" (e.g. "explore Subagent"), mirroring the
  // Claude Code integration's "general-purpose Subagent".
  const runName = sub.subagent_type ? `${sub.subagent_type} Subagent` : "Subagent";
  const subModel = deriveModelInfo(sub.model);
  const llmName = subModel.ls_provider ?? subModel.ls_model_name;
  const llmMeta = {
    ls_provider: subModel.ls_provider,
    ls_model_name: subModel.ls_model_name,
    ls_invocation_params: { model: subModel.ls_model_name },
  };

  // Subagent = nested chain run (validator runType "subagent"); children clear
  // ls_subagent_id/type so they don't leak down.
  const subagentRun = parent.createChild({
    name: runName,
    run_type: "chain",
    inputs: {
      subagent_type: sub.subagent_type,
      ...(sub.description ? { description: sub.description } : {}),
      task: sub.task,
    },
    outputs: {
      status: sub.status ?? "completed",
      ...(sub.resultText ? { result: sub.resultText } : {}),
    },
    error: isError ? sub.status : undefined,
    start_time: startMs,
    end_time: endMs,
    extra: {
      metadata: codingAgentMetadata({
        ...ctx,
        subagentId: sub.subagent_id,
        subagentType: sub.subagent_type,
        runSpecific: {
          ...(sub.description ? { subagent_description: sub.description } : {}),
          ...(sub.model ? { subagent_model: sub.model } : {}),
          ...(subModel.ls_provider ? { subagent_provider: subModel.ls_provider } : {}),
          ...(sub.is_parallel_worker != null
            ? { subagent_is_parallel_worker: sub.is_parallel_worker }
            : {}),
          ...(sub.childConversationId ? { subagent_conversation_id: sub.childConversationId } : {}),
          // Tools we actually captured (authoritative) vs Cursor-reported counts (often 0).
          subagent_tool_count: tools.length,
          ...(sub.message_count != null ? { reported_message_count: sub.message_count } : {}),
          ...(sub.tool_call_count != null ? { reported_tool_call_count: sub.tool_call_count } : {}),
          ...(sub.loop_count != null ? { reported_loop_count: sub.loop_count } : {}),
        },
      }),
    },
  });
  await subagentRun.postRun();

  const baseMessages = withSystem([{ role: "user", content: sub.task }], sub.systemPrompt);
  const finalBlocks = sub.resultText ? [{ type: "text", text: sub.resultText }] : [];
  const calls = tools.map((t) => toolCall(t, startMs)).sort((a, b) => a.startMs - b.startMs);

  if (calls.length === 0) {
    // No tools: a single llm run, system + task → final answer.
    const llmRun = subagentRun.createChild({
      name: llmName,
      run_type: "llm",
      inputs: { messages: baseMessages },
      outputs: { messages: [{ role: "assistant", content: finalBlocks }] },
      start_time: startMs,
      end_time: endMs,
      extra: {
        metadata: codingAgentMetadata({ ...ctx, clearSubagent: true, runSpecific: { ...llmMeta } }),
      },
    });
    await llmRun.postRun();
    return;
  }

  // Agentic subagent: decide llm → tool runs → answer llm.
  const firstCallStart = Math.min(...calls.map((c) => c.startMs));
  const lastCallEnd = Math.max(startMs, ...tools.map((t) => t.endMs));
  const assistantDecision = calls.map((c) => c.toolCallBlock);

  const decideRun = subagentRun.createChild({
    name: llmName,
    run_type: "llm",
    inputs: { messages: baseMessages },
    outputs: { messages: [{ role: "assistant", content: assistantDecision }] },
    start_time: startMs,
    end_time: Math.max(startMs, firstCallStart),
    extra: {
      metadata: codingAgentMetadata({ ...ctx, clearSubagent: true, runSpecific: { ...llmMeta } }),
    },
  });
  await decideRun.postRun();

  for (const tool of tools) await postToolRun(tool, subagentRun, ctx, true);

  const answerRun = subagentRun.createChild({
    name: llmName,
    run_type: "llm",
    inputs: {
      messages: [
        ...baseMessages,
        { role: "assistant", content: assistantDecision },
        ...calls.map((c) => c.resultMessage),
      ],
    },
    outputs: { messages: [{ role: "assistant", content: finalBlocks }] },
    start_time: lastCallEnd,
    end_time: endMs,
    extra: {
      metadata: codingAgentMetadata({ ...ctx, clearSubagent: true, runSpecific: { ...llmMeta } }),
    },
  });
  await answerRun.postRun();
}
