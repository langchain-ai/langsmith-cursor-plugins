import { describe, expect, it } from "vitest";
import {
  reduceAfterAgentResponse,
  reduceBeforeSubmitPrompt,
  reducePostToolUse,
  reduceStop,
} from "../src/reducer.js";
import type {
  AfterAgentResponseInput,
  BeforeSubmitPromptInput,
  PostToolUseInput,
  StopInput,
  TracingState,
} from "../src/types.js";
import { MINUTE, T0, conversation, turn } from "./utils/state.js";

const CONV = "c1";

function submit(generationId: string, prompt = "hi"): BeforeSubmitPromptInput {
  return {
    hook_event_name: "beforeSubmitPrompt",
    conversation_id: CONV,
    generation_id: generationId,
    model: "claude-4.6-sonnet",
    prompt,
  };
}

function stop(generationId: string): StopInput {
  return {
    hook_event_name: "stop",
    conversation_id: CONV,
    generation_id: generationId,
    model: "claude-4.6-sonnet",
    status: "completed",
  };
}

function toolUse(generationId: string, toolUseId: string): PostToolUseInput {
  return {
    hook_event_name: "postToolUse",
    conversation_id: CONV,
    generation_id: generationId,
    model: "claude-4.6-sonnet",
    tool_name: "read_file",
    tool_input: {},
    tool_output: "{}",
    tool_use_id: toolUseId,
  };
}

function response(generationId: string): AfterAgentResponseInput {
  return {
    hook_event_name: "afterAgentResponse",
    conversation_id: CONV,
    generation_id: generationId,
    model: "claude-4.6-sonnet",
    text: "done",
  };
}

describe("turn numbering", () => {
  it("numbers a turn when it starts", () => {
    let state: TracingState = {};
    state = reduceBeforeSubmitPrompt(state, submit("g1"), T0);
    expect(state[CONV].turns.g1.turnNum).toBe(1);
    expect(state[CONV].turns_started).toBe(1);
    expect(state[CONV].turn_count).toBe(0);
  });

  it("counts every started turn, including overlapping ones", () => {
    let state: TracingState = {};
    state = reduceBeforeSubmitPrompt(state, submit("g1"), T0);
    state = reduceBeforeSubmitPrompt(state, submit("g2"), T0 + MINUTE);
    state = reduceBeforeSubmitPrompt(state, submit("g3"), T0 + 2 * MINUTE);
    expect(Object.values(state[CONV].turns).map((t) => t.turnNum)).toEqual([1, 2, 3]);
  });

  it("does not renumber a turn on a duplicate prompt delivery", () => {
    let state: TracingState = {};
    state = reduceBeforeSubmitPrompt(state, submit("g1"), T0);
    state = reduceBeforeSubmitPrompt(state, submit("g1"), T0 + MINUTE);
    expect(state[CONV].turns.g1.turnNum).toBe(1);
    expect(state[CONV].turns_started).toBe(1);
  });

  it("numbers a turn born from a tool event when no prompt was seen", () => {
    let state: TracingState = {};
    state = reduceBeforeSubmitPrompt(state, submit("g1"), T0);
    state = reducePostToolUse(state, toolUse("g2", "t1"), T0 + MINUTE);
    expect(state[CONV].turns.g2.turnNum).toBe(2);
  });

  it("numbers a turn born from a final response when no prompt was seen", () => {
    let state: TracingState = {};
    state = reduceAfterAgentResponse(state, response("g1"), T0);
    expect(state[CONV].turns.g1.turnNum).toBe(1);
  });

  it("keeps start order when turns finish out of order", () => {
    let state: TracingState = {};
    state = reduceBeforeSubmitPrompt(state, submit("g1"), T0);
    state = reduceBeforeSubmitPrompt(state, submit("g2"), T0 + MINUTE);

    const second = reduceStop(state, stop("g2"), T0 + 2 * MINUTE);
    const first = reduceStop(second.state, stop("g1"), T0 + 3 * MINUTE);

    expect(second.turnNum).toBe(2);
    expect(first.turnNum).toBe(1);
  });

  it("issues a number at finish for a buffer saved before the upgrade", () => {
    const legacy = turn("g9", T0);
    delete legacy.turnNum;
    const state: TracingState = { [CONV]: conversation([legacy], { turn_count: 3 }) };

    const result = reduceStop(state, stop("g9"), T0 + MINUTE);

    expect(result.turnNum).toBe(4);
    expect(result.state[CONV].turns_started).toBe(4);
  });

  it("gives a turn started after the upgrade a number of its own", () => {
    const legacy = turn("g9", T0);
    delete legacy.turnNum;
    let state: TracingState = { [CONV]: conversation([legacy], { turn_count: 3 }) };

    state = reduceBeforeSubmitPrompt(state, submit("g10"), T0 + MINUTE);
    const result = reduceStop(state, stop("g9"), T0 + 2 * MINUTE);

    expect(state[CONV].turns.g10.turnNum).toBe(4);
    expect(result.turnNum).toBe(5);
  });

  it("still counts finished turns separately from started ones", () => {
    let state: TracingState = {};
    state = reduceBeforeSubmitPrompt(state, submit("g1"), T0);
    state = reduceBeforeSubmitPrompt(state, submit("g2"), T0 + MINUTE);
    const result = reduceStop(state, stop("g1"), T0 + 2 * MINUTE);

    expect(result.state[CONV].turn_count).toBe(1);
    expect(result.state[CONV].turns_started).toBe(2);
  });
});
