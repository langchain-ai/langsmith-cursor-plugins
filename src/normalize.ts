/**
 * Converters: Cursor hook payloads → LangSmith run shapes.
 *
 * - Model labels → ls_provider / ls_model_name (Cursor uses its own naming,
 *   e.g. "claude-4.6-sonnet-medium-thinking", "gpt-5.5-medium", "default").
 * - Cursor token fields → LangSmith usage_metadata.
 * - tool_output is a JSON-encoded string → parse it.
 * - Multimodal content parts → LangChain v1 ({ type, mime_type, base64 }) for
 *   inline UI rendering (kept for forward-compat; Cursor hooks don't currently
 *   surface attachment bytes).
 */

import type { UsageFields } from "./types.js";
import { canonicalModelId, computeCosts, lookupPricing, type ModelPricing } from "./pricing.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Model / provider ────────────────────────────────────────────────────────

/** Reasoning-effort / thinking suffixes Cursor appends to model labels. */
const MODEL_SUFFIXES = new Set(["thinking", "minimal", "low", "medium", "high"]);

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
 * Prefer a concrete model label over "default" (Auto mode). Within one turn the
 * model field can vary across hooks; this keeps the most specific value.
 */
export function preferModel(
  current: string | undefined,
  incoming: string | undefined,
): string | undefined {
  if (incoming && incoming.toLowerCase() !== "default") return incoming;
  return current ?? incoming;
}

/**
 * Derive { ls_model_name, ls_provider } from a Cursor model label.
 * The model name is suffix-stripped and normalized to a canonical provider id
 * (so LangSmith's price table can match it). "default" (Auto mode) → model
 * "default", provider "cursor".
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
 * Build LangSmith usage_metadata from Cursor's token fields. Cursor reports
 * input/output and cache read/write separately; we fold cache into input_tokens
 * (mirroring the Claude Code integration) and expose details.
 *
 * When a price table entry resolves for `modelId`, cost fields are attached
 * (input_cost / output_cost / total_cost / input_cost_details) so cost renders
 * even when LangSmith can't price the model server-side.
 *
 * Returns undefined when there are no tokens.
 */
export function buildUsageMetadata(
  usage: UsageFields | undefined,
  opts?: { modelId?: string; pricing?: Record<string, ModelPricing> },
) {
  if (!usage) return undefined;
  const cacheRead = usage.cache_read_tokens ?? 0;
  const cacheWrite = usage.cache_write_tokens ?? 0;
  const input_tokens = (usage.input_tokens ?? 0) + cacheRead + cacheWrite;
  const output_tokens = usage.output_tokens ?? 0;
  const total_tokens = input_tokens + output_tokens;

  if (total_tokens === 0) return undefined;

  const costs = computeCosts(usage, lookupPricing(opts?.modelId, opts?.pricing));

  return {
    input_tokens,
    output_tokens,
    total_tokens,
    input_token_details: { cache_read: cacheRead, cache_creation: cacheWrite },
    ...costs,
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

// ─── Multimodal content (forward-compat) ─────────────────────────────────────

const MULTIMODAL_PART_TYPES = new Set(["image", "file"]);

/**
 * Convert a custom binary content part ({ type, mimeType, data }) to the
 * LangChain v1 multimodal block ({ type, mime_type, base64 }) the LangSmith UI
 * renders inline. Non-multimodal parts pass through untouched.
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
