import { describe, it, expect } from "vitest";
import { parseFeedbackCommand } from "../src/feedback.js";
import { FEEDBACK_KEY } from "../src/constants.js";

describe("parseFeedbackCommand", () => {
  it("returns null for ordinary prompts (normal turn flow proceeds)", () => {
    expect(parseFeedbackCommand("fix the bug in auth.ts")).toBeNull();
    expect(parseFeedbackCommand("tell me about /langsmith")).toBeNull(); // prefix not first token
    expect(parseFeedbackCommand("")).toBeNull();
  });

  it("treats a bare prefix as a help request", () => {
    expect(parseFeedbackCommand("/langsmith")?.kind).toBe("help");
    expect(parseFeedbackCommand("  /ls  ")?.kind).toBe("help");
  });

  it("maps good/bad sentiments to scores under one key", () => {
    const good = parseFeedbackCommand("/langsmith good");
    expect(good).toMatchObject({ kind: "feedback", key: FEEDBACK_KEY, score: 1 });
    expect(good).not.toHaveProperty("comment");

    const bad = parseFeedbackCommand("/langsmith bad");
    expect(bad).toMatchObject({ kind: "feedback", score: 0 });
  });

  it("captures the trailing comment", () => {
    const fb = parseFeedbackCommand("/langsmith bad burned way too many tokens");
    expect(fb).toMatchObject({ score: 0, comment: "burned way too many tokens" });
  });

  it("flag is a bookmark (value, no score) and keeps its comment", () => {
    const fb = parseFeedbackCommand("/langsmith flag revisit this prompt");
    expect(fb).toMatchObject({ kind: "feedback", value: "flagged", comment: "revisit this prompt" });
    expect(fb).not.toHaveProperty("score");
  });

  it("falls back to a comment-only note when no sentiment keyword is given", () => {
    const fb = parseFeedbackCommand("/langsmith this was a weirdly good result");
    expect(fb).toMatchObject({ kind: "feedback", comment: "this was a weirdly good result" });
    expect(fb).not.toHaveProperty("score");
    expect(fb).not.toHaveProperty("value");
  });

  it("is case-insensitive on prefix and sentiment, and accepts the /ls alias and emoji", () => {
    expect(parseFeedbackCommand("/LangSmith GOOD")).toMatchObject({ score: 1 });
    expect(parseFeedbackCommand("/ls 👍")).toMatchObject({ score: 1 });
    expect(parseFeedbackCommand("/ls +1 nice")).toMatchObject({ score: 1, comment: "nice" });
  });
});
