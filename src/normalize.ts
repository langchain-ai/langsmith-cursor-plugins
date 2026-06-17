/**
 * Converters: Cursor hook payloads → LangSmith run shapes.
 *  - Model labels → ls_provider / ls_model_name
 *  - Cursor token fields → usage_metadata
 *  - tool_output (JSON string) → parsed
 *  - Multimodal parts → LangChain v1 (forward-compat)
 */

import type { UsageFields } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Model / provider ────────────────────────────────────────────────────────

/** Reasoning-effort / thinking suffixes Cursor appends to model labels. */
const MODEL_SUFFIXES = new Set(["thinking", "minimal", "low", "medium", "high"]);

/**
 * Explicit Cursor-label → canonical-id overrides for irregular cases the generic
 * reorder below can't derive. Empty by default (the regex covers the common
 * `claude-<ver>-<tier>` shape); add an entry only when a label is irregular.
 */
export const CANONICAL_MODEL_MAP: Record<string, string> = {};

/** Lowercase + strip a leading provider prefix some labels carry (e.g. "anthropic/"). */
function normKey(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+\//, "");
}

/**
 * Canonicalize a (suffix-stripped) Cursor model label to the id LangSmith's price
 * table matches. Cursor writes Claude labels version-first with a dotted version
 * (`claude-4.8-opus`); LangSmith's ids split the version on dashes and — from v4
 * on — put the tier first (`claude-opus-4-8`), while the v3 line keeps the version
 * first (`claude-3-7-sonnet`). We reorder by major version generically, so future
 * Anthropic releases need no new entries. Explicit overrides win; everything else
 * (GPT, Gemini, `claude-fable-5`, composer, …) passes through unchanged.
 */
export function canonicalModelId(model: string): string {
  const key = normKey(model);
  if (CANONICAL_MODEL_MAP[key]) return CANONICAL_MODEL_MAP[key];
  const m = key.match(/^claude-(\d+)\.(\d+)-(sonnet|opus|haiku)$/);
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
  if (/^(gpt|o\d)/.test(m)) return "openai";
  if (m.startsWith("gemini")) return "google";
  if (m.startsWith("grok")) return "xai";
  return undefined;
}

/** Strip trailing reasoning-effort/thinking suffixes from a model label. */
export function stripModelSuffixes(model: string): string {
  const parts = model.split("-");
  while (parts.length > 1 && MODEL_SUFFIXES.has(parts[parts.length - 1].toLowerCase())) {
    parts.pop();
  }
  return parts.join("-");
}

export interface ModelInfo {
  ls_model_name: string;
  ls_provider?: string;
}

/**
 * Prefer a concrete model label over "default" (Auto mode); keeps the most
 * specific value seen across a turn's hooks.
 */
export function preferModel(
  current: string | undefined,
  incoming: string | undefined,
): string | undefined {
  if (incoming && incoming.toLowerCase() !== "default") return incoming;
  return current ?? incoming;
}

/**
 * Derive { ls_model_name, ls_provider } from a Cursor model label: suffix-stripped
 * and canonicalized. "default" (Auto) → model "default", provider "cursor".
 */
export function deriveModelInfo(model: string | undefined): ModelInfo {
  const raw = (model ?? "").trim() || "default";
  return {
    ls_model_name: canonicalModelId(stripModelSuffixes(raw)),
    ls_provider: providerFor(raw),
  };
}

// ─── Usage + cost ────────────────────────────────────────────────────────────

/**
 * Build usage_metadata from Cursor's token fields, folding cache into
 * input_tokens. Cost is left to LangSmith's server-side price table (which prices
 * by the canonical ls_model_name). Undefined when no tokens.
 */
export function buildUsageMetadata(usage: UsageFields | undefined) {
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

/** MCP tool names arrive namespaced as "MCP:<tool>". */
export const MCP_TOOL_PREFIX = "MCP:";

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

// ─── Multimodal content (forward-compat) ─────────────────────────────────────

const MULTIMODAL_PART_TYPES = new Set(["image", "file"]);

/**
 * Convert a binary content part ({ type, mimeType, data }) to the LangChain v1
 * block ({ type, mime_type, base64 }). Non-multimodal parts pass through.
 */
export function normalizeContentPart(part: unknown): unknown {
  if (!isRecord(part)) return part;
  if (typeof part.type !== "string" || !MULTIMODAL_PART_TYPES.has(part.type)) return part;
  if (typeof part.mimeType !== "string" || typeof part.data !== "string") return part;
  const { mimeType, data, ...rest } = part;
  return { ...rest, mime_type: mimeType, base64: data };
}

export function normalizeContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map(normalizeContentPart);
}

// ─── Subagent transcript ─────────────────────────────────────────────────────

/** A tool call recovered from a subagent transcript (inputs only — no output). */
export interface SubagentToolCall {
  name: string;
  input: Record<string, unknown>;
}

/**
 * UI-only pseudo-tools the agent emits but never fires a real postToolUse for —
 * no I/O worth tracing.
 */
const SUBAGENT_PSEUDO_TOOLS = new Set(["UpdateCurrentStep"]);

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
