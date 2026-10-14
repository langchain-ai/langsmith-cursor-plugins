/**
 * Converters: Cursor hook payloads → LangSmith run shapes (model/provider,
 * usage_metadata, parsed tool_output, multimodal parts).
 */

import {
  CLAUDE_VERSIONED_MODEL,
  CURSOR_VENDOR_PREFIX,
  MCP_TOOL_PREFIX,
  MODEL_SUFFIXES,
  OPENAI_MODEL_PREFIX,
  PROVIDER_PREFIX,
  SUBAGENT_PSEUDO_TOOLS,
} from "./constants.js";
import type { UsageFields } from "./models/types.js";
import type { ModelInfo, SubagentToolCall, UsageMetadata } from "./models/normalize.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Model / provider ────────────────────────────────────────────────────────

/** Lowercase + strip a leading provider prefix some labels carry (e.g. "anthropic/"). */
function normKey(model: string): string {
  return model.trim().toLowerCase().replace(PROVIDER_PREFIX, "");
}

/** Canonicalize a Cursor model label to LangSmith's price-table id (Claude reordered by version). */
export function canonicalModelId(model: string): string {
  const key = normKey(model);
  const m = key.match(CLAUDE_VERSIONED_MODEL);
  if (m) {
    const [, major, minor, tier] = m;
    return Number(major) >= 4
      ? `claude-${tier}-${major}-${minor}` // v4+: tier-first
      : `claude-${major}-${minor}-${tier}`; // v3: version-first
  }
  return model;
}

/** Map a model-label prefix to a LangSmith ls_provider. */
function providerFor(model: string): string | undefined {
  const m = model.toLowerCase();
  if (m === "default" || m === "auto" || m.startsWith("composer") || m.startsWith("cursor")) {
    return "cursor";
  }
  if (m.startsWith("claude")) return "anthropic";
  if (OPENAI_MODEL_PREFIX.test(m)) return "openai";
  if (m.startsWith("gemini")) return "google";
  if (m.startsWith("grok")) return "xai";
  return undefined;
}

/** Strip trailing reasoning-effort/thinking suffixes from a model label. */
export function stripModelSuffixes(model: string): string {
  const parts = model.split("-");
  while (parts.length > 1) {
    const last = parts[parts.length - 1].toLowerCase();
    if (!MODEL_SUFFIXES.has(last)) break;
    if (last === "max" && !providerFor(parts.slice(0, -1).join("-"))) break;
    parts.pop();
  }
  return parts.join("-");
}

/** Prefer a concrete model label over "default" (Auto mode). */
export function preferModel(
  current: string | undefined,
  incoming: string | undefined,
): string | undefined {
  if (incoming && incoming.toLowerCase() !== "default") return incoming;
  return current ?? incoming;
}

/** Derive { ls_model_name, ls_provider } from a Cursor model label (suffix-stripped, canonical). */
export function deriveModelInfo(model: string | undefined): ModelInfo {
  const raw = (model ?? "").trim() || "default";
  const stripped = stripModelSuffixes(raw);
  const deprefixed = stripped.replace(CURSOR_VENDOR_PREFIX, "");
  const upstream = providerFor(deprefixed);
  const label = upstream && upstream !== "cursor" ? deprefixed : stripped;
  return {
    ls_model_name: canonicalModelId(label),
    ls_provider: providerFor(label) ?? providerFor(raw),
  };
}

// ─── Usage + cost ────────────────────────────────────────────────────────────

/** Build usage_metadata from token fields, folding cache into input_tokens; no cost (priced server-side). */
export function buildUsageMetadata(usage: UsageFields | undefined): UsageMetadata | undefined {
  if (!usage) return undefined;
  const cacheRead = usage.cache_read_tokens ?? 0;
  const cacheWrite = usage.cache_write_tokens ?? 0;
  const input_tokens = (usage.input_tokens ?? 0) + cacheRead + cacheWrite;
  const output_tokens = usage.output_tokens ?? 0;
  const total_tokens = input_tokens + output_tokens;

  if (total_tokens === 0) return undefined;

  return {
    input_tokens,
    output_tokens,
    total_tokens,
    input_token_details: { cache_read: cacheRead, cache_creation: cacheWrite },
  };
}

// ─── Tool output ─────────────────────────────────────────────────────────────

/** postToolUse.tool_output is a JSON-encoded string; parse it, else return raw. */
export function parseToolOutput(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (trimmed === "") return raw;
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

/** Join the text parts of an MCP tool result's `content` array, if any. */
function mcpContentToText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter(isRecord)
    .map((part) => (typeof part.text === "string" ? part.text : undefined))
    .filter((text): text is string => text != null && text !== "");
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/**
 * MCP tool failures never arrive via postToolUseFailure — Cursor routes them
 * through postToolUse with the error embedded in the (parsed) output. Detect the
 * clean case: an "MCP:"-prefixed tool whose output has `isError === true`, and
 * return a human-readable error string so the run can be flagged as an error.
 *
 * NB: hard protocol errors are laundered by Cursor into `isError: false` (the
 * message survives only as nested text), so they are intentionally NOT caught
 * here — that would require a brittle string heuristic.
 */
export function extractMcpError(toolName: string, output: unknown): string | undefined {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return undefined;
  if (!isRecord(output) || output.isError !== true) return undefined;
  return mcpContentToText(output.content) ?? "MCP tool returned isError: true";
}

// ─── Subagent transcript ─────────────────────────────────────────────────────

/**
 * Parse a subagent transcript into ordered tool calls (inputs only) and its
 * final assistant text (recorded nowhere else).
 */
export function parseSubagentTranscript(rows: unknown[]): {
  toolCalls: SubagentToolCall[];
  resultText?: string;
} {
  const toolCalls: SubagentToolCall[] = [];
  let resultText: string | undefined;

  for (const row of rows) {
    if (!isRecord(row) || row.role !== "assistant") continue;
    const message = isRecord(row.message) ? row.message : undefined;
    const content = message?.content;
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part.type === "tool_use" && typeof part.name === "string") {
        if (SUBAGENT_PSEUDO_TOOLS.has(part.name)) continue;
        toolCalls.push({ name: part.name, input: isRecord(part.input) ? part.input : {} });
      } else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        resultText = part.text; // keep the last non-empty assistant text
      }
    }
  }

  return { toolCalls, resultText };
}
