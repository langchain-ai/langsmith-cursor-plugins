import { resolveTurnAttachments } from "./attachments.js";
import { resolveTurnSteps } from "./conversation-steps.js";
import { resolveSystemPrompts } from "./system-prompt.js";
import type { Config } from "./models/config.js";
import type { BuildTurnOptions } from "./models/langsmith.js";
import type { ContentPart } from "./models/types.js";

export function enrichTurn(config: Config, options: BuildTurnOptions): BuildTurnOptions {
  const { buffer: toTrace, conversationId } = options;

  // Best-effort attachment enrichment (read-only DB + disk); never throws, and an
  // empty result leaves the turn unchanged.
  let attachments: ContentPart[] = [];
  if (config.attachmentsEnabled && toTrace.tracingMode === "full") {
    attachments = resolveTurnAttachments({
      conversationId,
      prompt: toTrace.prompt,
      dbPath: config.cursorDbPath,
    });
  }

  // Best-effort system-prompt enrichment (read-only DB + protobuf field decode);
  // never throws, and undefined leaves the llm runs unchanged.
  let systemPrompt: string | undefined;
  if (config.systemPromptEnabled && toTrace.tracingMode === "full") {
    // Resolve the main turn + every subagent's child conversation over ONE DB
    // connection (avoids an open-per-subagent explosion with many subagents).
    const childIds = toTrace.subagents
      .map((s) => s.childConversationId)
      .filter((id): id is string => !!id);
    const prompts = resolveSystemPrompts({
      conversationIds: [conversationId, ...childIds],
      dbPath: config.cursorDbPath,
    });
    systemPrompt = prompts.get(conversationId);
    for (const sub of toTrace.subagents) {
      if (sub.childConversationId) sub.systemPrompt = prompts.get(sub.childConversationId);
    }
  }

  // Best-effort interleaved step fidelity; undefined falls back to the hook-built shape.
  const steps = resolveTurnSteps({
    conversationId,
    toolUseIds: toTrace.tools.map((t) => t.tool_use_id),
    dbPath: config.cursorDbPath,
  });

  return { ...options, attachments, systemPrompt, steps };
}
