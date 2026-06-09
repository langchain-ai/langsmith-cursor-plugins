import { describe, it, expect } from "vitest";
import { canonicalModelId, lookupPricing, computeCosts } from "../src/pricing.js";

describe("canonicalModelId", () => {
  it("maps known Cursor labels to canonical provider ids", () => {
    expect(canonicalModelId("claude-4.6-sonnet")).toBe("claude-sonnet-4-6");
  });
  it("passes through unknown labels unchanged", () => {
    expect(canonicalModelId("gpt-5.5")).toBe("gpt-5.5");
    expect(canonicalModelId("mystery")).toBe("mystery");
  });
});

describe("lookupPricing", () => {
  it("resolves built-in pricing by canonical id and by Cursor label", () => {
    expect(lookupPricing("claude-sonnet-4-6")).toBeDefined();
    expect(lookupPricing("claude-4.6-sonnet")).toBeDefined();
  });
  it("prefers caller overrides over the built-in table", () => {
    const p = lookupPricing("claude-sonnet-4-6", {
      "claude-sonnet-4-6": { input: 99, output: 1 },
    });
    expect(p?.input).toBe(99);
  });
  it("returns undefined for unknown models", () => {
    expect(lookupPricing("totally-unknown")).toBeUndefined();
    expect(lookupPricing(undefined)).toBeUndefined();
  });
});

describe("computeCosts", () => {
  it("prices base input, output, and cache tokens at their own rates", () => {
    const costs = computeCosts(
      {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_tokens: 1_000_000,
        cache_write_tokens: 1_000_000,
      },
      { input: 3, output: 15, cache_read: 0.3, cache_creation: 3.75 },
    )!;
    expect(costs.input_cost).toBeCloseTo(3 + 0.3 + 3.75, 5); // base + cache read + cache create
    expect(costs.output_cost).toBeCloseTo(15, 5);
    expect(costs.total_cost).toBeCloseTo(22.05, 5);
    expect(costs.input_cost_details).toEqual({ cache_read: 0.3, cache_creation: 3.75 });
  });

  it("falls back to the input rate when cache rates are unset", () => {
    const costs = computeCosts(
      { input_tokens: 0, output_tokens: 0, cache_read_tokens: 1_000_000 },
      { input: 2, output: 8 },
    )!;
    expect(costs.input_cost).toBeCloseTo(2, 5); // cache_read priced at input rate
  });

  it("returns undefined without usage or pricing", () => {
    expect(computeCosts(undefined, { input: 1, output: 1 })).toBeUndefined();
    expect(computeCosts({ input_tokens: 1 }, undefined)).toBeUndefined();
  });
});
