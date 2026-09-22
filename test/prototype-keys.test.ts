import { describe, expect, it, afterEach } from "vitest";
import {
  reduceAfterAgentResponse,
  reduceBeforeSubmitPrompt,
  reducePostToolUse,
  reducePostToolUseFailure,
  reduceStop,
  reduceSubagentStart,
  reduceSubagentStop,
  reduceSweep,
  reduceUploadSettled,
} from "../src/reducer.js";
import {
  getConversationState,
  getTurnBuffer,
  loadState,
  pruneOldConversations,
  saveState,
} from "../src/state.js";
import type { TracingState } from "../src/types.js";
import { HOUR, MINUTE, T0, conversation, turn } from "./utils/state.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const POISON = ["__proto__", "constructor", "prototype", "toString"] as const;

const SENTINELS = [
  "polluted",
  "turns",
  "pending",
  "turn_count",
  "startMs",
  "tools",
  "subagents",
] as const;

function prototypeSnapshot(): string[] {
  return SENTINELS.filter((key) => key in ({} as Record<string, unknown>));
}

function base(id: string, event: string) {
  return {
    hook_event_name: event,
    conversation_id: id,
    generation_id: id,
    model: "default",
  };
}

function driveEveryReducer(id: string): TracingState {
  let state: TracingState = {};
  state = reduceBeforeSubmitPrompt(
    state,
    { ...base(id, "beforeSubmitPrompt"), prompt: "hi" } as never,
    T0,
  );
  state = reducePostToolUse(
    state,
    {
      ...base(id, "postToolUse"),
      tool_name: "Read",
      tool_input: {},
      tool_output: "{}",
      tool_use_id: "t1",
    } as never,
    T0 + MINUTE,
  );
  state = reducePostToolUseFailure(
    state,
    {
      ...base(id, "postToolUseFailure"),
      tool_name: "Write",
      tool_input: {},
      tool_use_id: "t2",
      error_message: "no",
    } as never,
    T0 + 2 * MINUTE,
  );
  state = reduceAfterAgentResponse(
    state,
    { ...base(id, "afterAgentResponse"), text: "done" } as never,
    T0 + 3 * MINUTE,
  );
  state = reduceSubagentStart(
    state,
    {
      ...base(id, "subagentStart"),
      subagent_id: id,
      subagent_type: "explore",
      task: "go",
    } as never,
    T0 + 4 * MINUTE,
  );
  state = reduceSubagentStop(
    state,
    { ...base(id, "subagentStop"), subagent_id: id, subagent_type: "explore" } as never,
    T0 + 5 * MINUTE,
    { childConversationId: id },
  );
  return state;
}

describe("a generation id that names a prototype key", () => {
  afterEach(() => {
    for (const key of SENTINELS) delete (Object.prototype as Record<string, unknown>)[key];
  });

  it.each(POISON)("never reaches Object.prototype through any reducer: %s", (id) => {
    const state = driveEveryReducer(id);

    expect(prototypeSnapshot()).toEqual([]);
    expect(Object.hasOwn(state, id)).toBe(true);
    expect(Object.hasOwn(state[id].turns, id)).toBe(true);
  });

  it.each(POISON)("survives the whole sweep lifecycle intact: %s", (id) => {
    let state = driveEveryReducer(id);

    const swept = reduceSweep(state, "someone-else", T0 + 10 * HOUR, HOUR);
    expect(swept.claims.map((c) => c.generationId)).toEqual([id]);
    expect(Object.hasOwn(swept.state[id].pending!, id)).toBe(true);
    expect(prototypeSnapshot()).toEqual([]);

    state = reduceUploadSettled(swept.state, id, id, T0 + 10 * HOUR);
    expect(state[id].pending).toBeUndefined();
    expect(Object.hasOwn(state[id].turns, id)).toBe(true);

    const stopped = reduceStop(state, base(id, "stop") as never, T0 + 11 * HOUR);
    expect(stopped.buffer?.generation_id).toBe(id);
    expect(stopped.turnNum).toBe(1);
    expect(Object.hasOwn(stopped.state[id].pending!, id)).toBe(true);
    expect(prototypeSnapshot()).toEqual([]);
  });

  it.each(POISON)("reads back as its own entry, not the prototype's: %s", (id) => {
    const state = driveEveryReducer(id);

    expect(getTurnBuffer(state, id, id)?.generation_id).toBe(id);
    expect(getTurnBuffer({}, id, id)).toBeUndefined();
    expect(getConversationState({}, id)).toEqual({ turns: {}, turn_count: 0, updated: "" });
    expect(Object.hasOwn(pruneOldConversations(state, Date.now()), id)).toBe(true);
  });

  it("ignores a poisoned key planted in the state file on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "proto-state-"));
    const file = join(dir, "state.json");
    const healthy = JSON.stringify(conversation([turn("g1", T0, { tracingMode: "full" })]));
    writeFileSync(
      file,
      `{"__proto__":{"polluted":true,"turns":{},"turn_count":0,"updated":""},"c1":${healthy}}`,
    );

    const loaded = loadState(file);
    expect(Object.hasOwn(loaded, "__proto__")).toBe(true);
    expect(prototypeSnapshot()).toEqual([]);

    const stopped = reduceStop(
      loaded,
      { ...base("c1", "stop"), generation_id: "g1" } as never,
      T0 + MINUTE,
    );
    saveState(file, stopped.state);

    expect(prototypeSnapshot()).toEqual([]);
    expect(loadState(file).c1.pending!.g1.turnNum).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
