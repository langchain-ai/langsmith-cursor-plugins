import { readFileSync } from "node:fs";
import type { TracingState, TurnBuffer, StopInput } from "../../src/types.js";
import {
  reduceBeforeSubmitPrompt,
  reducePostToolUse,
  reducePostToolUseFailure,
  reduceAfterAgentResponse,
  reduceSubagentStart,
  reduceSubagentStop,
  reduceStop,
} from "../../src/reducer.js";

export interface FinalizedTurn {
  conversationId: string;
  turnNum: number;
  buffer: TurnBuffer;
  stopInput: StopInput;
}

interface CaptureLine {
  ts: string;
  evt: string;
  payload: Record<string, unknown> & { hook_event_name: string };
}

/**
 * Replay a captured diagnostics hooks.jsonl through the pure reducers, using
 * each event's recorded timestamp as the wall clock. Returns the turns that a
 * `stop` finalized (in order) plus the residual state (e.g. orphan subagent
 * conversations that never `stop`).
 */
export function replayHookLog(path: string): {
  finalized: FinalizedTurn[];
  finalState: TracingState;
} {
  let state: TracingState = {};
  const finalized: FinalizedTurn[] = [];

  for (const line of readFileSync(path, "utf-8").split("\n").filter(Boolean)) {
    let rec: CaptureLine;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const p = rec.payload;
    const now = Date.parse(rec.ts);

    switch (p.hook_event_name) {
      case "beforeSubmitPrompt":
        state = reduceBeforeSubmitPrompt(state, p as never, now);
        break;
      case "postToolUse":
        state = reducePostToolUse(state, p as never, now);
        break;
      case "postToolUseFailure":
        state = reducePostToolUseFailure(state, p as never, now);
        break;
      case "afterAgentResponse":
        state = reduceAfterAgentResponse(state, p as never, now);
        break;
      case "subagentStart":
        state = reduceSubagentStart(state, p as never, now);
        break;
      case "subagentStop":
        state = reduceSubagentStop(state, p as never, now);
        break;
      case "stop": {
        const r = reduceStop(state, p as never, now);
        state = r.state;
        if (r.buffer) {
          finalized.push({
            conversationId: p.conversation_id as string,
            turnNum: r.turnNum,
            buffer: r.buffer,
            stopInput: p as never,
          });
        }
        break;
      }
      default:
        break; // beforeReadFile / afterAgentThought / sessionStart / shell / MCP — ignored in v1
    }
  }

  return { finalized, finalState: state };
}
