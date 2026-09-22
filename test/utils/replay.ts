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
  reduceSweep,
  type SweepClaim,
} from "../../src/reducer.js";
import { pruneOldConversations } from "../../src/state.js";
import { DEFAULT_SWEEP_IDLE_MINUTES } from "../../src/constants.js";

export interface FinalizedTurn {
  conversationId: string;
  turnNum: number;
  buffer: TurnBuffer;
  stopInput: StopInput;
}

export interface ReplayOptions {
  finalSweep?: { nowMs: number; callerConversationId: string };
}

interface CaptureLine {
  ts: string;
  evt: string;
  payload: Record<string, unknown> & { hook_event_name: string };
}

/**
 * Replay captured hooks.jsonl through the pure reducers, using each event's
 * timestamp as the clock. Yields finalized turns and residual state.
 */
export function replayHookLog(
  path: string,
  options: ReplayOptions = {},
): {
  finalized: FinalizedTurn[];
  swept: SweepClaim[];
  finalState: TracingState;
} {
  let state: TracingState = {};
  const finalized: FinalizedTurn[] = [];
  const swept: SweepClaim[] = [];
  function sweepEveryOtherThread(callerConversationId: string, nowMs: number): void {
    const result = reduceSweep(
      state,
      callerConversationId,
      nowMs,
      DEFAULT_SWEEP_IDLE_MINUTES * 60_000,
    );
    state = result.state;
    swept.push(...result.claims);
  }

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
      case "sessionStart":
        state = pruneOldConversations(state, now);
        break;
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
        break; // beforeReadFile / afterAgentThought / shell / MCP — ignored in v1
    }
    sweepEveryOtherThread(p.conversation_id as string, now);
  }

  if (options.finalSweep) {
    sweepEveryOtherThread(options.finalSweep.callerConversationId, options.finalSweep.nowMs);
  }

  return { finalized, swept, finalState: state };
}
