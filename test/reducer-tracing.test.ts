import { describe, expect, it } from "vitest";
import {
  reduceBeforeSubmitPrompt,
  reducePostToolUse,
  reduceSubagentStart,
} from "../src/reducer.js";
import { applyTraceCommand } from "../src/trace-control.js";
import type { TracingState } from "../src/types.js";

function prompt(conversationId: string, generationId: string, text: string) {
  return {
    hook_event_name: "beforeSubmitPrompt" as const,
    conversation_id: conversationId,
    generation_id: generationId,
    model: "cursor-small",
    prompt: text,
  };
}

describe("child tracing inference", () => {
  it("never promotes an explicitly muted top-level thread beside a sole open full subagent", () => {
    let state: TracingState = {};
    state = reduceBeforeSubmitPrompt(state, prompt("thread-a", "turn-a", "public"), 1000);
    state = reduceSubagentStart(
      state,
      {
        hook_event_name: "subagentStart",
        conversation_id: "thread-a",
        generation_id: "turn-a",
        model: "cursor-small",
        subagent_id: "subagent-a",
        subagent_type: "explore",
        task: "work",
      },
      1100,
    );
    state = applyTraceCommand(state, "thread-b", "off");
    state = reduceBeforeSubmitPrompt(state, prompt("thread-b", "turn-b", "B secret"), 1200);

    expect(state["thread-b"].tracing).toBe("metadata");
    expect(state["thread-b"].parent_conversation_id).toBeUndefined();
    expect(state["thread-b"].turns["turn-b"].tracing_mode).toBe("metadata");
    expect(state["thread-b"].turns["turn-b"].prompt).toBeUndefined();
    expect(JSON.stringify(state["thread-b"])).not.toContain("B secret");
  });

  it("defaults an unknown conversation to metadata when sole-open-subagent inference is not explicit", () => {
    let state: TracingState = {};
    state = reduceBeforeSubmitPrompt(state, prompt("parent", "parent-turn", "public"), 1000);
    state = reduceSubagentStart(
      state,
      {
        hook_event_name: "subagentStart",
        conversation_id: "parent",
        generation_id: "parent-turn",
        model: "cursor-small",
        subagent_id: "subagent",
        subagent_type: "explore",
        task: "work",
      },
      1100,
    );
    state = reduceBeforeSubmitPrompt(state, prompt("unknown", "unknown-turn", "secret"), 1200);

    expect(state.unknown.tracing).toBe("metadata");
    expect(state.unknown.turns["unknown-turn"].tracing_mode).toBe("metadata");
    expect(state.unknown.turns["unknown-turn"].prompt).toBeUndefined();
  });

  it("lets an explicit parent mapping inherit the parent turn mode", () => {
    let state: TracingState = {};
    state = reduceBeforeSubmitPrompt(state, prompt("parent", "parent-turn", "public"), 1000);
    state.child = {
      turns: {},
      turn_count: 0,
      updated: "",
      parent_conversation_id: "parent",
      parent_generation_id: "parent-turn",
    };
    state = reduceBeforeSubmitPrompt(state, prompt("child", "child-turn", "allowed"), 1100);

    expect(state.child.turns["child-turn"].tracing_mode).toBe("full");
    expect(state.child.turns["child-turn"].prompt).toBe("allowed");
  });

  it("never promotes a metadata turn after conversation tracing is enabled", () => {
    let state = applyTraceCommand({}, "thread", "off");
    state = reduceBeforeSubmitPrompt(state, prompt("thread", "turn", "hidden"), 1000);
    state = applyTraceCommand(state, "thread", "on");
    state = reduceBeforeSubmitPrompt(state, prompt("thread", "turn", "incoming secret"), 1100);
    state = reducePostToolUse(
      state,
      {
        hook_event_name: "postToolUse",
        conversation_id: "thread",
        generation_id: "turn",
        model: "cursor-small",
        tool_use_id: "secret id",
        tool_name: "Read",
        tool_input: { path: "secret input" },
        tool_output: "secret output",
      },
      1200,
    );

    expect(state.thread.tracing).toBeUndefined();
    expect(state.thread.turns.turn.tracing_mode).toBe("metadata");
    expect(JSON.stringify(state)).not.toContain("secret");
  });
});
