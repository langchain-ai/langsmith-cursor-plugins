import { describe, it, expect } from "vitest";
import {
  deriveModelInfo,
  stripModelSuffixes,
  preferModel,
  buildUsageMetadata,
  parseToolOutput,
  normalizeContentPart,
} from "../src/normalize.js";
import { lookupPricing } from "../src/pricing.js";

describe("deriveModelInfo / provider mapping", () => {
  it("maps Cursor model labels to ls_provider and a canonical model id", () => {
    expect(deriveModelInfo("claude-4.6-sonnet-medium-thinking")).toEqual({
      ls_model_name: "claude-sonnet-4-6", // normalized to canonical id
      ls_provider: "anthropic",
    });
    expect(deriveModelInfo("gpt-5.5-medium")).toEqual({
      ls_model_name: "gpt-5.5",
      ls_provider: "openai",
    });
    expect(deriveModelInfo("composer-2.5-fast")).toEqual({
      ls_model_name: "composer-2.5-fast",
      ls_provider: "cursor",
    });
    expect(deriveModelInfo("gemini-2.5-pro")).toMatchObject({ ls_provider: "google" });
  });

  it("treats Auto-mode 'default' as the cursor provider", () => {
    expect(deriveModelInfo("default")).toEqual({ ls_model_name: "default", ls_provider: "cursor" });
    expect(deriveModelInfo(undefined)).toEqual({ ls_model_name: "default", ls_provider: "cursor" });
  });

  it("leaves provider undefined for unknown vendors", () => {
    expect(deriveModelInfo("llama-3.1-70b").ls_provider).toBeUndefined();
  });
});

describe("stripModelSuffixes", () => {
  it("strips trailing reasoning-effort / thinking suffixes only", () => {
    expect(stripModelSuffixes("gpt-5.5-medium")).toBe("gpt-5.5");
    expect(stripModelSuffixes("claude-4.6-sonnet-medium-thinking")).toBe("claude-4.6-sonnet");
    expect(stripModelSuffixes("gpt-5.5")).toBe("gpt-5.5");
    expect(stripModelSuffixes("composer-2.5-fast")).toBe("composer-2.5-fast");
  });
});

describe("preferModel", () => {
  it("prefers a concrete label over default", () => {
    expect(preferModel("default", "gpt-5.5")).toBe("gpt-5.5");
    expect(preferModel("gpt-5.5", "default")).toBe("gpt-5.5");
    expect(preferModel(undefined, "default")).toBe("default");
    expect(preferModel("gpt-5.5-medium", "gpt-5.5")).toBe("gpt-5.5");
  });
});

describe("buildUsageMetadata", () => {
  it("folds cache tokens into input_tokens and exposes details", () => {
    expect(
      buildUsageMetadata({
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 960,
        cache_write_tokens: 5,
      }),
    ).toEqual({
      input_tokens: 1065,
      output_tokens: 20,
      total_tokens: 1085,
      input_token_details: { cache_read: 960, cache_creation: 5 },
    });
  });

  it("returns undefined when there are no tokens", () => {
    expect(buildUsageMetadata(undefined)).toBeUndefined();
    expect(buildUsageMetadata({})).toBeUndefined();
    expect(buildUsageMetadata({ input_tokens: 0, output_tokens: 0 })).toBeUndefined();
  });

  it("does not attach cost without a resolvable price", () => {
    const u = buildUsageMetadata({ input_tokens: 100, output_tokens: 20 }) as Record<
      string,
      unknown
    >;
    expect(u.total_cost).toBeUndefined();
  });

  it("attaches cost when the model is priced (built-in table)", () => {
    // Rates come from the pricing module (one source of truth). At 1M in/out,
    // per-token cost equals the per-1M rate.
    const price = lookupPricing("claude-sonnet-4-6")!;
    const u = buildUsageMetadata(
      {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      },
      { modelId: "claude-sonnet-4-6" },
    ) as Record<string, unknown>;
    expect(u.input_cost).toBeCloseTo(price.input, 5);
    expect(u.output_cost).toBeCloseTo(price.output, 5);
    expect(u.total_cost).toBeCloseTo(price.input + price.output, 5);
  });

  it("resolves cost via the Cursor label too (claude-4.6-sonnet)", () => {
    const price = lookupPricing("claude-4.6-sonnet")!;
    const u = buildUsageMetadata(
      { input_tokens: 1_000_000, output_tokens: 0 },
      { modelId: "claude-4.6-sonnet" },
    ) as Record<string, unknown>;
    expect(u.input_cost).toBeCloseTo(price.input, 5);
  });

  it("honors caller pricing overrides", () => {
    const u = buildUsageMetadata(
      { input_tokens: 1_000_000, output_tokens: 0 },
      { modelId: "mystery-model", pricing: { "mystery-model": { input: 7, output: 21 } } },
    ) as Record<string, unknown>;
    expect(u.input_cost).toBeCloseTo(7, 5);
  });
});

describe("parseToolOutput", () => {
  it("parses a JSON-encoded tool_output string", () => {
    expect(parseToolOutput('{"output":"hello"}')).toEqual({ output: "hello" });
  });
  it("returns the raw value for non-JSON strings and non-strings", () => {
    expect(parseToolOutput("plain text")).toBe("plain text");
    expect(parseToolOutput(42)).toBe(42);
    expect(parseToolOutput("")).toBe("");
  });
});

describe("normalizeContentPart", () => {
  it("converts a custom binary part to LangChain v1", () => {
    expect(normalizeContentPart({ type: "image", mimeType: "image/png", data: "AAAA" })).toEqual({
      type: "image",
      mime_type: "image/png",
      base64: "AAAA",
    });
  });
  it("passes through non-multimodal parts", () => {
    expect(normalizeContentPart({ type: "text", text: "hi" })).toEqual({
      type: "text",
      text: "hi",
    });
  });
});
