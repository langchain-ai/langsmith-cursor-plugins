/** LangSmith run construction: one trace per turn via RunTree, threaded by conversation_id. */

import { MUTED_TRACE_CONTENT } from "@langchain/plugins-base/privacy";
import { hookOutputs } from "@langchain/plugins-base/tracing";
import { RunTree } from "langsmith";
import type { ToolEvent, SubagentEvent, ContentPart, TurnBuffer } from "./models/types.js";
import type {
  BuildTurnOptions,
  LlmRunSpec,
  MetaCtx,
  RunSpec,
  SkillRunOptions,
  TurnCall,
  TurnContext,
} from "./models/langsmith.js";
import { buildUsageMetadata, deriveModelInfo } from "./normalize.js";
import {
  DEFAULT_TAGS,
  EMPTY_TOOL_ID_PREFIX,
  SKILL_RUN_NAME,
  TOOL_FAILED_MESSAGE,
  TURN_RUN_NAME,
} from "./constants.js";
import { codingAgentMetadata, skillNameFromTool, withIntegration } from "./metadata.js";
import type { CursorMetadataOptions } from "./models/metadata.js";
import type { CapturedRun } from "./models/tracing-engine.js";
import { groupSteps } from "./conversation-steps.js";
import type { Round } from "./models/conversation-steps.js";
import { readableText } from "./utils/text.js";
import * as logger from "./logger.js";
import { createHash } from "node:crypto";

// ─── Turn → run tree ─────────────────────────────────────────────────────────

function uuidFromDigest(hex: string): string {
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function stableRunId(ctx: MetaCtx, key: string): string {
  const seed = `${ctx.threadId}\u0000${ctx.turnId ?? ""}\u0000${key}`;
  return uuidFromDigest(createHash("sha256").update(seed).digest("hex"));
}

export function turnRunId(conversationId: string, generationId: string): string {
  return stableRunId({ agentType: "root", threadId: conversationId, turnId: generationId }, "turn");
}

export function toolRunId(conversationId: string, buffer: TurnBuffer, toolIndex: number): string {
  const ctx: MetaCtx = {
    agentType: "root",
    threadId: conversationId,
    turnId: buffer.generation_id,
  };
  return stableRunId(ctx, toolKey(toolIndex, buffer.tools[toolIndex]));
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

/** Tool start = end − duration (milliseconds). Clamp so start never exceeds end. */
function toolStartMs(tool: ToolEvent): number {
  return Math.max(0, Math.round(tool.endMs - (tool.duration ?? 0)));
}

function toolError(tool: ToolEvent): string | undefined {
  if (tool.error == null && tool.failure_type == null) return undefined;
  return tool.error || tool.failure_type || TOOL_FAILED_MESSAGE;
}

/** Render a tool's output (or error) as text for a tool-result message. */
function toolResultText(tool: ToolEvent): string {
  const error = toolError(tool);
  if (error != null) return error;
  const out = tool.output;
  if (out == null) return "";
  return readableText(out) || JSON.stringify(out);
}

function callEntry(
  id: string,
  name: string,
  args: unknown,
  text: string,
): Pick<TurnCall, "toolCall" | "resultMessage"> {
  return {
    toolCall: { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
    resultMessage: { role: "tool", tool_call_id: id, content: [{ type: "text", text }] },
  };
}

/** One tool event → its ordered TurnCall (tool call + tool-result message). */
function toolCall(t: ToolEvent, floorMs: number): TurnCall {
  return {
    startMs: Math.max(floorMs, toolStartMs(t)),
    endMs: t.endMs,
    ...callEntry(t.tool_use_id, t.name, t.input, toolResultText(t)),
    tool: t,
  };
}

/** Tool/subagent calls this turn, ordered by start, each paired with its result message. */
function orderedTurnCalls(buffer: TurnBuffer): TurnCall[] {
  const calls: TurnCall[] = [
    ...buffer.tools.map((t) => toolCall(t, buffer.startMs)),
    ...buffer.subagents.map((s) => ({
      startMs: s.startMs,
      endMs: s.endMs ?? s.startMs,
      ...callEntry(
        s.subagent_id,
        "Subagent",
        {
          subagent_type: s.subagent_type,
          task: s.tracingMode === "full" ? s.task : MUTED_TRACE_CONTENT,
        },
        s.tracingMode === "full"
          ? (s.resultText ?? `status: ${s.status ?? "completed"}`)
          : MUTED_TRACE_CONTENT,
      ),
    })),
  ];
  return calls.sort((a, b) => a.startMs - b.startMs);
}

function assistantMessage(
  content: Array<Record<string, unknown>>,
  calls: TurnCall[] = [],
): Record<string, unknown> | undefined {
  if (content.length === 0 && calls.length === 0) return undefined;
  return {
    role: "assistant",
    content,
    ...(calls.length ? { tool_calls: calls.map((c) => c.toolCall) } : {}),
  };
}

/** Build the full LangSmith trace for one finalized turn. */
export function buildTurnRuns(options: BuildTurnOptions): CapturedRun[] {
  if (options.buffer.tracingMode === "off") return [];
  const turn = createTurnContext(options);
  const { buffer, conversationId, turnNum } = options;

  // Root turn run. createChild derives ids, trace_id and dotted_order for children.
  const turnRun = addRootRun(turn);
  const interleaved = options.steps?.length ? addInterleavedRounds(turn, turnRun) : false;
  if (!interleaved) {
    if (turn.calls.length === 0) addSingleLlmRun(turn, turnRun);
    else addAgenticRuns(turn, turnRun);
  }

  turnRun.end_time = turn.turnEndMs;
  turnRun.outputs = { text: buffer.finalText ?? "", ...hookOutputs(options.hooks?.outputs ?? []) };
  turnRun.error = buffer.status && buffer.status !== "completed" ? buffer.status : undefined;

  logger.log(
    `Traced ${TURN_RUN_NAME} ${turnNum} (conv=${conversationId}): ${buffer.tools.length} tool(s), ${buffer.subagents.length} subagent(s)`,
  );
  return turn.runs;
}

export function buildToolRuns(options: BuildTurnOptions, toolIndex: number): CapturedRun[] {
  const tool = options.buffer.tools[toolIndex];
  if (!tool) return [];
  const turn = createTurnContext(options);
  addToolRun(turn, addRootRun(turn), turn.ctx, tool, toolKey(toolIndex, tool));
  return turn.runs;
}

function toolKey(index: number, tool: ToolEvent): string {
  return `tool:${index}:${tool.tool_use_id}`;
}

function createTurnContext(options: BuildTurnOptions): TurnContext {
  const { buffer, conversationId, turnNum, userEmail, customMetadata } = options;
  // coding-agent-v1 context, stamped on the root and propagated to children
  // via createChild. user_email (per-turn) joins the config base.
  const ctx: MetaCtx = {
    agentType: "root",
    threadId: conversationId,
    base: { ...customMetadata, ...(userEmail ? { user_email: userEmail } : {}) },
    turnId: buffer.generation_id,
    turnNumber: turnNum,
    runtimeVersion: options.runtimeVersion,
  };

  const { ls_model_name, ls_provider } = deriveModelInfo(buffer.model);
  // Turn end = latest event time we know about, falling back to now.
  const toolEnds = buffer.tools.map((t) => t.endMs);
  const subagentEnds = buffer.subagents.map((s) => s.endMs ?? s.startMs);

  return {
    options,
    ctx,
    runs: [],
    mode: buffer.tracingMode === "full" ? "full" : "metadata",
    userContent: userMessageContent(buffer.prompt ?? "", options.attachments ?? []),
    llmName: ls_provider ?? ls_model_name,
    llmMeta: {
      runType: "llm",
      modelName: ls_model_name,
      runSpecific: { ls_provider, ls_invocation_params: { model: ls_model_name } },
    },
    usageMetadata: buildUsageMetadata(buffer.usage),
    thinking: thinkingBlocks(
      buffer.thoughts.length
        ? buffer.thoughts
        : (options.steps ?? []).filter((s) => s.kind === "thinking"),
    ),
    finalTextBlocks: buffer.finalText ? [{ type: "text", text: buffer.finalText }] : [],
    calls: orderedTurnCalls(buffer),
    turnEndMs: Math.max(
      buffer.startMs,
      ...toolEnds,
      ...subagentEnds,
      options.savedAtMs ?? Date.now(),
    ),
  };
}

function addRootRun(turn: TurnContext): RunTree {
  const { options, ctx } = turn;
  const run = new RunTree({
    id: stableRunId(ctx, "turn"),
    name: `${TURN_RUN_NAME} ${options.turnNum}`,
    run_type: "chain",
    inputs: {
      messages: [{ role: "user", content: turn.userContent }],
      ...hookOutputs(options.hooks?.inputs ?? []),
    },
    project_name: options.project,
    start_time: options.buffer.startMs,
    tags: DEFAULT_TAGS,
    extra: { metadata: codingAgentMetadata(rootMetadata(turn)) },
  });
  turn.runs.push({ run, mode: turn.mode, metadata: withIntegration(rootMetadata(turn)) });
  return run;
}

function rootMetadata({ ctx, options }: TurnContext): CursorMetadataOptions {
  return { ...ctx, runType: "root", runSpecific: { model: options.buffer.model } };
}

/** Create a run under `parent`, record it for capture, and return it. */
function addRun(turn: TurnContext, parent: RunTree, spec: RunSpec): RunTree {
  const run = parent.createChild({
    id: stableRunId(turn.ctx, spec.key),
    name: spec.name,
    run_type: spec.type,
    inputs: spec.inputs,
    outputs: spec.outputs,
    ...(spec.error === undefined ? {} : { error: spec.error }),
    start_time: spec.startMs,
    end_time: spec.endMs,
    extra: { metadata: codingAgentMetadata(spec.metadata) },
  });
  const parentMode = turn.runs.find((c) => c.run.id === parent.id)?.mode;
  turn.runs.push({
    run,
    mode: parentMode === "metadata" ? "metadata" : (spec.mode ?? parentMode ?? "full"),
    metadata: withIntegration(spec.metadata),
  });
  return run;
}

function addLlmRun(turn: TurnContext, parent: RunTree, spec: LlmRunSpec): RunTree {
  const message = assistantMessage(spec.content, spec.calls);
  return addRun(turn, parent, {
    key: spec.key,
    name: spec.name,
    type: "llm",
    inputs: { messages: spec.messages },
    outputs: { messages: message ? [message] : [] },
    startMs: spec.startMs,
    endMs: spec.endMs,
    metadata: spec.metadata,
  });
}

/** A turn with no tools: a single llm run, user → assistant (thinking + final text). */
function addSingleLlmRun(turn: TurnContext, turnRun: RunTree): void {
  const { options, ctx } = turn;
  addLlmRun(turn, turnRun, {
    key: "llm",
    name: turn.llmName,
    messages: withSystem([{ role: "user", content: turn.userContent }], options.systemPrompt),
    content: [...turn.thinking, ...turn.finalTextBlocks],
    startMs: options.buffer.startMs,
    endMs: turn.turnEndMs,
    metadata: { ...ctx, ...turn.llmMeta, usageMetadata: turn.usageMetadata },
  });
}

/** An agentic turn: "decide" llm → tool runs → "answer" llm fed the results. */
function addAgenticRuns(turn: TurnContext, turnRun: RunTree): void {
  const { options, ctx, calls } = turn;
  const { buffer, systemPrompt } = options;
  const firstCallStart = Math.min(...calls.map((c) => c.startMs));
  const lastCallEnd = Math.max(
    buffer.startMs,
    ...buffer.tools.map((t) => t.endMs),
    ...buffer.subagents.map((s) => s.endMs ?? s.startMs),
  );
  const assistantDecision = assistantMessage(turn.thinking, calls);

  // "decide" llm — emits the tool calls. Usage goes on the answer run.
  addLlmRun(turn, turnRun, {
    key: "decide",
    name: turn.llmName,
    messages: withSystem([{ role: "user", content: turn.userContent }], systemPrompt),
    content: turn.thinking,
    calls,
    startMs: buffer.startMs,
    endMs: Math.max(buffer.startMs, firstCallStart),
    metadata: { ...ctx, ...turn.llmMeta },
  });

  // Tool runs (and subagent Task runs) between the two llm calls.
  for (const [i, tool] of buffer.tools.entries())
    addToolRun(turn, turnRun, ctx, tool, toolKey(i, tool));
  for (const [i, sub] of buffer.subagents.entries())
    addSubagentRun(turn, turnRun, sub, `subagent:${i}:${sub.subagent_id}`);

  // "answer" llm — tool results fed back in, produces the final text.
  addLlmRun(turn, turnRun, {
    key: "answer",
    name: turn.llmName,
    messages: withSystem(
      [
        { role: "user", content: turn.userContent },
        assistantDecision!,
        ...calls.map((c) => c.resultMessage),
      ],
      systemPrompt,
    ),
    content: turn.finalTextBlocks,
    startMs: lastCallEnd,
    endMs: turn.turnEndMs,
    metadata: { ...ctx, ...turn.llmMeta, usageMetadata: turn.usageMetadata },
  });
}

/** Thinking content blocks for the rounds with non-empty text. */
function thinkingBlocks(
  thinking: Array<{ text?: string; durationMs?: number }>,
): Array<Record<string, unknown>> {
  return thinking.flatMap((t) => (t.text ? [{ type: "thinking", thinking: t.text }] : []));
}

function placeRoundCalls(turn: TurnContext, rounds: Round[]): TurnCall[][] | undefined {
  const unplaced = new Map(turn.calls.map((c) => [c.toolCall.id, c]));
  const idless = turn.calls.filter((c) => c.toolCall.id.startsWith(EMPTY_TOOL_ID_PREFIX));
  let anyMatched = false;
  const placed = rounds.map((round) =>
    round.toolSteps.flatMap((ts) => {
      const call = ts.toolUseId
        ? unplaced.get(ts.toolUseId)
        : idless.find((c) => unplaced.has(c.toolCall.id));
      if (!call) return [];
      anyMatched ||= Boolean(ts.toolUseId && call.tool);
      unplaced.delete(call.toolCall.id);
      return [call];
    }),
  );
  if (!anyMatched) return undefined;
  for (const call of unplaced.values()) {
    const round =
      [...placed].reverse().find((calls) => calls.some((c) => c.startMs <= call.startMs)) ??
      placed[0];
    const at = round.findIndex((c) => c.startMs > call.startMs);
    round.splice(at < 0 ? round.length : at, 0, call);
  }
  return placed;
}

/**
 * Render the turn as interleaved per-round llm + tool runs from the decoded steps.
 * Returns false when the steps don't line up with hook tools, so the caller falls back.
 */
function addInterleavedRounds(turn: TurnContext, turnRun: RunTree): boolean {
  const { options, ctx } = turn;
  const { buffer, systemPrompt } = options;

  const rounds = groupSteps(options.steps ?? []);
  if (rounds.length === 0) return false;

  // The trailing text-only round (if any) is the final answer; the rest emit tools.
  const last = rounds[rounds.length - 1];
  const finalRound = last.toolSteps.length === 0 ? last : undefined;
  const actionRounds = finalRound ? rounds.slice(0, -1) : rounds;

  // Need at least one tool that lines up with the hook buffer to justify interleaving.
  const placed = placeRoundCalls(turn, actionRounds);
  if (!placed) return false;

  const msgs: Array<Record<string, unknown>> = [{ role: "user", content: turn.userContent }];
  let cursorMs = buffer.startMs;

  for (const [roundIndex, round] of actionRounds.entries()) {
    const calls = placed[roundIndex];
    const textBlocks = round.assistantText ? [{ type: "text", text: round.assistantText }] : [];
    const assistantContent = [...thinkingBlocks(round.thinking), ...textBlocks];

    addLlmRun(turn, turnRun, {
      key: `round:${roundIndex}`,
      name: turn.llmName,
      messages: withSystem([...msgs], systemPrompt),
      content: assistantContent,
      calls,
      startMs: cursorMs,
      endMs: calls.length ? Math.max(cursorMs, Math.min(...calls.map((c) => c.startMs))) : cursorMs,
      metadata: { ...ctx, ...turn.llmMeta },
    });

    for (const { tool: t } of calls)
      if (t) addToolRun(turn, turnRun, ctx, t, toolKey(buffer.tools.indexOf(t), t));

    // Thread this round's assistant turn + tool results into the running conversation.
    const assistant = assistantMessage(assistantContent, calls);
    if (assistant) msgs.push(assistant);
    for (const c of calls) msgs.push(c.resultMessage);
    if (calls.length) cursorMs = Math.max(cursorMs, ...calls.map((c) => c.endMs));
  }

  // Subagents render as nested chains, ordered in the UI by their own start_time.
  for (const [i, sub] of buffer.subagents.entries())
    addSubagentRun(turn, turnRun, sub, `subagent:${i}:${sub.subagent_id}`);

  // Final answer llm — carries turn usage; folds in any trailing text-only round.
  addLlmRun(turn, turnRun, {
    key: "answer",
    name: turn.llmName,
    messages: withSystem([...msgs], systemPrompt),
    content: [...thinkingBlocks(finalRound?.thinking ?? []), ...turn.finalTextBlocks],
    startMs: cursorMs,
    endMs: turn.turnEndMs,
    metadata: { ...ctx, ...turn.llmMeta, usageMetadata: turn.usageMetadata },
  });
  return true;
}

/** Add one tool run under `parent`. `clearSubagent` neutralizes inherited subagent keys. */
function addToolRun(
  turn: TurnContext,
  parent: RunTree,
  ctx: MetaCtx,
  tool: ToolEvent,
  key: string,
  clearSubagent = false,
): void {
  // Clamp start to the parent's — Cursor tool durations can exceed the turn,
  // mis-sorting tools ahead of the llm.
  const floorMs = typeof parent.start_time === "number" ? parent.start_time : 0;
  const startMs = Math.max(floorMs, toolStartMs(tool));
  const error = toolError(tool);
  const hooks = turn.options.hooks?.tools.get(tool.tool_use_id);

  addRun(turn, parent, {
    key,
    name: tool.name,
    type: "tool",
    inputs: { input: tool.input, ...hookOutputs(hooks?.inputs ?? []) },
    outputs: {
      ...(error != null ? { error } : { output: tool.output ?? "" }),
      ...hookOutputs(hooks?.outputs ?? []),
    },
    error,
    startMs,
    endMs: tool.endMs,
    metadata: {
      ...ctx,
      runType: "tool",
      clearSubagent,
      // run name == native tool name, so ls_tool_name is omitted; tool_name kept as alias.
      toolName: tool.name,
      runName: tool.name,
      runSpecific: {
        tool_name: tool.name,
        tool_use_id: tool.tool_use_id,
        ...(tool.failure_type ? { failure_type: tool.failure_type } : {}),
      },
    },
  });

  const skillName = skillNameFromTool(tool.name, tool.input);
  if (skillName) {
    addSkillRun(turn, parent, ctx, `${key}:skill`, clearSubagent, {
      skillName,
      // A failure hook may carry no message, so failure_type is the surer signal.
      success: tool.error == null && tool.failure_type == null,
      startMs,
      endMs: tool.endMs,
    });
  }
}

/** Adds the one run that carries `ls_skill_name`, so an invocation is counted once. */
function addSkillRun(
  turn: TurnContext,
  parent: RunTree,
  ctx: MetaCtx,
  key: string,
  clearSubagent: boolean,
  opts: SkillRunOptions,
): void {
  addRun(turn, parent, {
    key,
    name: SKILL_RUN_NAME,
    type: "tool",
    // The `input`/`output` wrapper puts these fields where Claude Code's are.
    inputs: { input: { skill: opts.skillName } },
    outputs: { output: { commandName: opts.skillName, success: opts.success } },
    startMs: opts.startMs,
    endMs: opts.endMs,
    metadata: {
      ...ctx,
      runType: "tool",
      clearSubagent,
      // Equal names are what suppress `ls_tool_name`.
      toolName: SKILL_RUN_NAME,
      runName: SKILL_RUN_NAME,
      skillName: opts.skillName,
      // No tool_use_id: Cursor issued no such call.
      runSpecific: { tool_name: SKILL_RUN_NAME },
    },
  });
}

/** A subagent: a nested chain run whose llm and tool runs hang beneath it. */
function addSubagentRun(turn: TurnContext, parent: RunTree, sub: SubagentEvent, key: string): void {
  const subagentCtx: MetaCtx = { ...turn.ctx, agentType: "subagent" };
  const subagentRun = addSubagentChain(turn, parent, sub, key, subagentCtx);
  const tools = sub.tools ?? [];
  if (tools.length === 0) addSubagentSingleLlmRun(turn, subagentRun, sub, key, subagentCtx);
  else addSubagentAgenticRuns(turn, subagentRun, sub, key, subagentCtx);
}

/** The chain run for the subagent itself (validator runType "subagent"). */
function addSubagentChain(
  turn: TurnContext,
  parent: RunTree,
  sub: SubagentEvent,
  key: string,
  subagentCtx: MetaCtx,
): RunTree {
  const isError = sub.status != null && sub.status !== "completed";
  const subModel = deriveModelInfo(sub.model);
  return addRun(turn, parent, {
    key,
    // Name the node "<type> Subagent" (e.g. "explore Subagent"), mirroring the
    // Claude Code integration's "general-purpose Subagent".
    name: sub.subagent_type ? `${sub.subagent_type} Subagent` : "Subagent",
    type: "chain",
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
    startMs: sub.startMs,
    endMs: sub.endMs ?? sub.startMs,
    mode: sub.tracingMode === "full" ? "full" : "metadata",
    metadata: {
      ...subagentCtx,
      runType: "subagent",
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
        subagent_tool_count: (sub.tools ?? []).length,
        ...(sub.message_count != null ? { reported_message_count: sub.message_count } : {}),
        ...(sub.tool_call_count != null ? { reported_tool_call_count: sub.tool_call_count } : {}),
        ...(sub.loop_count != null ? { reported_loop_count: sub.loop_count } : {}),
      },
    },
  });
}

/** The llm of a subagent: name and metadata come from the subagent's own model. */
function subagentLlm(
  sub: SubagentEvent,
  subagentCtx: MetaCtx,
): { name: string; metadata: CursorMetadataOptions } {
  const subModel = deriveModelInfo(sub.model);
  return {
    name: subModel.ls_provider ?? subModel.ls_model_name,
    metadata: {
      ...subagentCtx,
      clearSubagent: true,
      runType: "llm",
      modelName: subModel.ls_model_name,
      runSpecific: {
        ls_provider: subModel.ls_provider,
        ls_invocation_params: { model: subModel.ls_model_name },
      },
    },
  };
}

/** Role "system": the task is the orchestrator's instruction, not a human turn. */
function subagentMessages(sub: SubagentEvent): Array<Record<string, unknown>> {
  return withSystem([{ role: "system", content: sub.task }], sub.systemPrompt);
}

function subagentFinalBlocks(sub: SubagentEvent): Array<Record<string, unknown>> {
  return sub.resultText ? [{ type: "text", text: sub.resultText }] : [];
}

/** No tools: a single llm run, system + task → final answer. */
function addSubagentSingleLlmRun(
  turn: TurnContext,
  subagentRun: RunTree,
  sub: SubagentEvent,
  key: string,
  subagentCtx: MetaCtx,
): void {
  const llm = subagentLlm(sub, subagentCtx);
  addLlmRun(turn, subagentRun, {
    key: `${key}:llm`,
    name: llm.name,
    messages: subagentMessages(sub),
    content: subagentFinalBlocks(sub),
    startMs: sub.startMs,
    endMs: sub.endMs ?? sub.startMs,
    metadata: llm.metadata,
  });
}

/** Agentic subagent: decide llm → tool runs → answer llm. */
function addSubagentAgenticRuns(
  turn: TurnContext,
  subagentRun: RunTree,
  sub: SubagentEvent,
  key: string,
  subagentCtx: MetaCtx,
): void {
  const tools = sub.tools ?? [];
  const startMs = sub.startMs;
  const endMs = sub.endMs ?? sub.startMs;
  const llm = subagentLlm(sub, subagentCtx);
  const baseMessages = subagentMessages(sub);
  const calls = tools.map((t) => toolCall(t, startMs)).sort((a, b) => a.startMs - b.startMs);
  const firstCallStart = Math.min(...calls.map((c) => c.startMs));
  const lastCallEnd = Math.max(startMs, ...tools.map((t) => t.endMs));
  addLlmRun(turn, subagentRun, {
    key: `${key}:decide`,
    name: llm.name,
    messages: baseMessages,
    content: [],
    calls,
    startMs,
    endMs: Math.max(startMs, firstCallStart),
    metadata: llm.metadata,
  });

  for (const [i, tool] of tools.entries())
    addToolRun(turn, subagentRun, subagentCtx, tool, `${key}:tool:${i}:${tool.tool_use_id}`, true);

  addLlmRun(turn, subagentRun, {
    key: `${key}:answer`,
    name: llm.name,
    messages: [...baseMessages, assistantMessage([], calls)!, ...calls.map((c) => c.resultMessage)],
    content: subagentFinalBlocks(sub),
    startMs: lastCallEnd,
    endMs,
    metadata: llm.metadata,
  });
}
