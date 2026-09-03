import { describe, expect, it } from "vitest";
import {
  applyTraceCommand,
  parseTraceCommand,
  traceCommandMessage,
  tracingMode,
} from "../src/trace-control.js";
import { loadState, pruneOldConversations } from "../src/state.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("trace controls", () => {
  it("matches only the exact lowercase grammar", () => {
    expect(parseTraceCommand("/trace on")).toBe("on");
    expect(parseTraceCommand("/trace off")).toBe("off");
    expect(parseTraceCommand("/trace status")).toBe("status");
    expect(parseTraceCommand("/trace OFF")).toBeUndefined();
    expect(parseTraceCommand("/trace off ")).toBeUndefined();
    expect(parseTraceCommand("/trace status please")).toBeUndefined();
    expect(parseTraceCommand("prefix /trace off")).toBeUndefined();
    expect(parseTraceCommand("/traceoff")).toBeUndefined();
    expect(parseTraceCommand("/trace offline")).toBeUndefined();
  });

  it("persists metadata mode and removes it on enable", () => {
    let state = applyTraceCommand({}, "thread", "off");
    expect(state.thread.tracing).toBe("metadata");
    state = pruneOldConversations(state, Date.now() + 48 * 60 * 60 * 1000);
    expect(state.thread.tracing).toBe("metadata");
    state = applyTraceCommand(state, "thread", "on");
    expect(state.thread.tracing).toBeUndefined();
  });

  it("defaults malformed persisted state to metadata and commands recover it", () => {
    const file = join(mkdtempSync(join(tmpdir(), "trace-control-")), "state.json");
    writeFileSync(file, JSON.stringify({ thread: { turns: "bad" } }));
    const corrupt = loadState(file);
    expect(tracingMode(corrupt, "thread")).toBe("metadata");
    const recovered = applyTraceCommand(corrupt, "thread", "on");
    expect(recovered.__langsmith_corrupt_state__).toBeUndefined();
    expect(tracingMode(recovered, "thread")).toBe("full");
  });

  it("uses consistent messages and keeps the master switch dominant", () => {
    expect(traceCommandMessage("on", "full")).toBe("LangSmith tracing is on for this thread.");
    expect(traceCommandMessage("status", "metadata")).toBe(
      "LangSmith tracing is off for this thread (metadata only).",
    );
    expect(traceCommandMessage("on", "full", false)).toContain("disabled by the master switch");
    expect(traceCommandMessage("on", "full", false)).not.toContain(
      "tracing is on for this thread.",
    );
  });
});
