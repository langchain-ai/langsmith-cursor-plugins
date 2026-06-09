/**
 * Model-name normalization + cost computation.
 *
 * Two cooperating mechanisms make cost render in LangSmith for Cursor traces:
 *
 *  1. Normalization — map Cursor's model labels (e.g. "claude-4.6-sonnet") to a
 *     canonical provider model id so LangSmith's server-side price table can
 *     match it. Also improves model/provider querying.
 *  2. Cost attachment — compute input/output/total cost ourselves from a price
 *     table and attach it to usage_metadata (like the Pi integration). This is
 *     the robust fallback: cost renders even when LangSmith can't price the model.
 *
 * Prices below are **list-price estimates (USD per 1M tokens)** and are meant to
 * be overridden via config (`model_pricing` in langsmith.json, or
 * CURSOR_LANGSMITH_MODEL_PRICING). Keys are lowercased canonical ids and/or the
 * Cursor labels we see, so lookups hit with or without normalization.
 */

import type { UsageFields } from "./types.js";

export interface ModelPricing {
  /** USD per 1M input (prompt) tokens. */
  input: number;
  /** USD per 1M output (completion) tokens. */
  output: number;
  /** USD per 1M cache-read tokens (defaults to `input` if omitted). */
  cache_read?: number;
  /** USD per 1M cache-creation/write tokens (defaults to `input` if omitted). */
  cache_creation?: number;
}

/**
 * Cursor model label (lowercased, suffix-stripped) → canonical provider model id
 * that LangSmith's price table recognizes. Pass-through when unmapped.
 */
export const CANONICAL_MODEL_MAP: Record<string, string> = {
  "claude-4.6-sonnet": "claude-sonnet-4-6",
  "claude-4.6-opus": "claude-opus-4-6",
  "claude-4.6-haiku": "claude-haiku-4-6",
  // GPT / Gemini Cursor labels generally already match canonical ids.
};

/**
 * Built-in price table (USD per 1M tokens). List-price estimates as of early
 * 2026 — override via config for accuracy or unlisted models. Keyed by
 * lowercased canonical id and common Cursor labels.
 */
export const BUILTIN_PRICING: Record<string, ModelPricing> = {
  // Anthropic — Sonnet tier (Claude 3.5 / 4 / 4.6 Sonnet share list pricing)
  "claude-sonnet-4-6": { input: 3, output: 15, cache_read: 0.3, cache_creation: 3.75 },
  "claude-4.6-sonnet": { input: 3, output: 15, cache_read: 0.3, cache_creation: 3.75 },
  // Anthropic — Opus / Haiku tiers
  "claude-opus-4-6": { input: 15, output: 75, cache_read: 1.5, cache_creation: 18.75 },
  "claude-4.6-opus": { input: 15, output: 75, cache_read: 1.5, cache_creation: 18.75 },
  "claude-haiku-4-6": { input: 0.8, output: 4, cache_read: 0.08, cache_creation: 1.0 },
  "claude-4.6-haiku": { input: 0.8, output: 4, cache_read: 0.08, cache_creation: 1.0 },
  // OpenAI — approximate; override via config if exact rates matter.
  "gpt-5.5": { input: 1.25, output: 10, cache_read: 0.125 },
};

/** Lowercase + strip a leading provider prefix some labels carry (e.g. "anthropic/"). */
function normKey(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+\//, "");
}

/** Map a (suffix-stripped) model label to its canonical id, or return it unchanged. */
export function canonicalModelId(model: string): string {
  return CANONICAL_MODEL_MAP[normKey(model)] ?? model;
}

/** Resolve pricing for a model id, preferring caller overrides over the built-in table. */
export function lookupPricing(
  modelId: string | undefined,
  overrides?: Record<string, ModelPricing>,
): ModelPricing | undefined {
  if (!modelId) return undefined;
  const key = normKey(modelId);
  const canonical = normKey(canonicalModelId(modelId));
  return (
    overrides?.[key] ?? overrides?.[canonical] ?? BUILTIN_PRICING[key] ?? BUILTIN_PRICING[canonical]
  );
}

export interface CostFields {
  input_cost: number;
  output_cost: number;
  total_cost: number;
  input_cost_details: { cache_read: number; cache_creation: number };
}

/**
 * Compute cost (USD) from raw Cursor token fields and a price table.
 * Cache-read/creation tokens are priced at their own rates, falling back to the
 * input rate. Returns undefined when no pricing is available.
 */
export function computeCosts(
  usage: UsageFields | undefined,
  pricing: ModelPricing | undefined,
): CostFields | undefined {
  if (!usage || !pricing) return undefined;
  const per = (tokens: number, rate: number) => (tokens * rate) / 1_000_000;

  const baseInput = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_tokens ?? 0;
  const cacheWrite = usage.cache_write_tokens ?? 0;
  const output = usage.output_tokens ?? 0;

  const cacheReadCost = per(cacheRead, pricing.cache_read ?? pricing.input);
  const cacheCreationCost = per(cacheWrite, pricing.cache_creation ?? pricing.input);
  const input_cost = per(baseInput, pricing.input) + cacheReadCost + cacheCreationCost;
  const output_cost = per(output, pricing.output);

  return {
    input_cost,
    output_cost,
    total_cost: input_cost + output_cost,
    input_cost_details: { cache_read: cacheReadCost, cache_creation: cacheCreationCost },
  };
}
