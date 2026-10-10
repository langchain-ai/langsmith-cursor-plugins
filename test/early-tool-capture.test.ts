import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCursorTracingSession } from "../src/tracing-engine.js";
import { captureEarlyCursorToolSource } from "../src/early-tool-capture.js";
import { readCursorNativeTurnSource } from "../src/native-turn-source.js";
import { loadState, saveState } from "../src/state.js";
import { originFromConfig } from "../src/turn-origin.js";
import type { Config } from "../src/config.js";
import type { PostToolUseInput } from "../src/types.js";
import { conversation, testConfig, turn } from "./utils/state.js";

let directory: string;
let stateFilePath: string;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function setup(): Config {
  directory = mkdtempSync(join(tmpdir(), "cursor-early-tool-capture-"));
  stateFilePath = join(directory, "state.json");
  vi.stubEnv("HOME", directory);
  vi.stubEnv("USERPROFILE", directory);
  vi.stubEnv("TRACE_TO_LANGSMITH", "true");
  vi.stubEnv("LANGSMITH_CURSOR_API_KEY", "MOCK");
  vi.stubEnv("LANGSMITH_CURSOR_ENDPOINT", "https://api.smith.langchain.com");
  vi.stubEnv("LANGSMITH_CURSOR_PROJECT", "cursor");
  vi.stubEnv("LANGSMITH_CURSOR_STATE_FILE", stateFilePath);
  return {
    ...testConfig(stateFilePath),
    customMetadata: { cwd: "/caller/workspace" },
  };
}

function input(): PostToolUseInput {
  return {
    hook_event_name: "postToolUse",
    conversation_id: "early-conversation",
    session_id: "early-session",
    generation_id: "early-turn",
    model: "default",
    workspace_roots: ["/changed/workspace"],
    tool_name: "Shell",
    tool_use_id: "tool-event-1",
    tool_input: { command: "echo private" },
    tool_output: '"saved result"',
  };
}

it("saves a completed tool before the native turn-state update", async () => {
  const config = setup();
  saveState(stateFilePath, {
    "early-conversation": {
      turns: {
        "early-turn": {
          tracingMode: "full",
          origin: originFromConfig(
            {
              ...config,
              project: "launch-project",
              customMetadata: { ...config.customMetadata, cwd: "/original/workspace" },
            },
            { ...input(), workspace_roots: ["/original/workspace"] },
          ),
          generation_id: "early-turn",
          turnNum: 3,
          startMs: 1000,
          prompt: "launch prompt",
          tools: [],
          thoughts: [],
          subagents: [],
        },
      },
      turn_count: 2,
      updated: new Date(1000).toISOString(),
    },
  });
  const event = input();
  const captured = await captureEarlyCursorToolSource(config, event, 2000);
  expect(
    loadState(stateFilePath)[event.conversation_id]?.turns[event.generation_id]?.tools,
  ).toEqual([]);
  expect(captured?.source.buffer.tools).toMatchObject([
    { tool_use_id: event.tool_use_id, input: event.tool_input, output: "saved result" },
  ]);

  const tracing = createCursorTracingSession(
    config,
    event.session_id!,
    "/original/workspace",
    undefined,
    "launch-project",
  );
  if (!tracing || !captured) throw new Error("Early tool capture was not created");
  const loaded = await readCursorNativeTurnSource(
    tracing.storageRoot,
    event.session_id!,
    event.generation_id,
    tracing.destinationFingerprint,
    captured.sourceRef,
  );
  expect(loaded.route?.cwd).toBe("/original/workspace");
  expect(loaded.source.turnNum).toBe(3);
});

it.each([
  { label: "no saved privacy mode", mode: undefined },
  { label: "an off launch", mode: "off" as const },
])("skips early source capture for $label", async ({ mode }) => {
  const config = setup();
  saveState(stateFilePath, {
    "early-conversation": {
      turns: {
        "early-turn": {
          tracingMode: mode,
          generation_id: "early-turn",
          turnNum: 1,
          startMs: 1000,
          tools: [],
          thoughts: [],
          subagents: [],
        },
      },
      turn_count: 0,
      updated: new Date(1000).toISOString(),
    },
  });

  await expect(captureEarlyCursorToolSource(config, input(), 2000)).resolves.toBeUndefined();
});

it("saves a main-thread tool while a subagent is still open", async () => {
  const config = setup();
  const event = input();
  saveState(stateFilePath, {
    "early-conversation": {
      turns: {
        "early-turn": {
          tracingMode: "full",
          origin: originFromConfig(config, event),
          generation_id: "early-turn",
          turnNum: 1,
          startMs: 1000,
          tools: [],
          thoughts: [],
          subagents: [
            {
              subagent_id: "running-child",
              subagent_type: "Task",
              task: "work",
              startMs: 1500,
            },
          ],
        },
      },
      turn_count: 0,
      updated: new Date(1000).toISOString(),
    },
  });
  const captured = await captureEarlyCursorToolSource(config, event, 2000);

  expect(captured?.source.buffer.tools).toMatchObject([
    { tool_use_id: event.tool_use_id, input: event.tool_input, output: "saved result" },
  ]);
  expect(captured?.source.buffer.subagents).toMatchObject([
    { subagent_id: "running-child", subagent_type: "Task" },
  ]);
  expect(
    loadState(stateFilePath)[event.conversation_id]?.turns[event.generation_id]?.tools,
  ).toEqual([]);
});

it("skips early capture for a known child conversation", async () => {
  const config = setup();
  saveState(stateFilePath, {
    parent: conversation([
      turn("parent-turn", 1000, {
        subagents: [
          {
            subagent_id: "child",
            subagent_type: "Task",
            task: "work",
            startMs: 1500,
            childConversationId: "early-conversation",
          },
        ],
      }),
    ]),
    "early-conversation": conversation([turn("early-turn", 1000, { tracingMode: "full" })]),
  });

  await expect(captureEarlyCursorToolSource(config, input(), 2000)).resolves.toBeUndefined();
});
