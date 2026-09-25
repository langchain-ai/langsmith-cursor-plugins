import { afterEach, beforeEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { getThreadTracingMode } from "../src/tracing-policy.js";
import { loadState } from "../src/state.js";

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cursor-control-"));
  env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/^(LANGSMITH_|LANGCHAIN_|TRACE_TO_LANGSMITH)/.test(k),
    ),
  );
  Object.assign(env, {
    HOME: dir,
    USERPROFILE: dir,
    TRACE_TO_LANGSMITH: "false",
    LANGSMITH_CURSOR_STATE_FILE: join(dir, "state.json"),
    LANGSMITH_CURSOR_PRIVACY_FILE: join(dir, "privacy.json"),
    LANGSMITH_CURSOR_LOG_FILE: join(dir, "hook.log"),
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function submit(prompt: string, generation_id = "generation", cwd = dir) {
  const hooks = JSON.parse(readFileSync(new URL("../hooks.json", import.meta.url), "utf8"));
  const registration = hooks.hooks.beforeSubmitPrompt[0];
  expect(registration).toMatchObject({ failClosed: true, timeout: 15 });
  const match = /^node BUNDLE_DIR\/guard.js (before-submit-prompt)$/.exec(registration.command);
  expect(match).not.toBeNull();
  const result = spawnSync(
    process.execPath,
    [new URL("../bundle/guard.js", import.meta.url).pathname, match![1]],
    {
      cwd,
      env,
      encoding: "utf8",
      timeout: 10000,
      input: JSON.stringify({
        prompt,
        generation_id,
        conversation_id: "thread",
        model: "default",
        hook_event_name: "beforeSubmitPrompt",
        workspace_roots: [dir],
      }),
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

it("registers the same blocking contract for plugin and installer", () => {
  const plugin = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"));
  expect(plugin.hooks.beforeSubmitPrompt[0]).toMatchObject({ failClosed: true, timeout: 15 });
  expect(plugin.hooks.beforeSubmitPrompt[0].command).toContain(
    '${CURSOR_PLUGIN_ROOT}/binary/langsmith-tracing" before-submit-prompt',
  );
  const result = spawnSync(
    process.execPath,
    [new URL("../scripts/install.mjs", import.meta.url).pathname, "--print"],
    { env, encoding: "utf8" },
  );
  expect(JSON.parse(result.stdout).hooks.beforeSubmitPrompt[0]).toMatchObject({
    failClosed: true,
    timeout: 15,
  });
});

it("persists exact controls across fresh hook processes while master off; no trace buffer touched", () => {
  writeFileSync(env.LANGSMITH_CURSOR_STATE_FILE!, "existing in-flight state");
  for (const command of ["mute", "unmute"] as const) {
    const response = submit(`langsmith-tracing:${command}`);
    expect(response.continue).toBe(false);
    expect(response.user_message).toContain("next turn; the current turn is unchanged");
    expect(response.user_message).toContain("Master tracing is disabled");
    expect(getThreadTracingMode(env.LANGSMITH_CURSOR_PRIVACY_FILE!, "thread")).toBe(
      command === "mute" ? "metadata" : "full",
    );
    expect(readFileSync(env.LANGSMITH_CURSOR_STATE_FILE!, "utf8")).toBe("existing in-flight state");
  }
});

it.each([
  "/langsmith-tracing:mute",
  "langsmith-tracing:mute now",
  " langsmith-tracing:mute",
  "langsmith-tracing:mute\n",
])("does not interpret %j", (prompt) => {
  expect(submit(prompt).continue).toBe(true);
  expect(loadState(env.LANGSMITH_CURSOR_STATE_FILE!).thread.turns.generation.tracingMode).toBe(
    "off",
  );
  expect(getThreadTracingMode(env.LANGSMITH_CURSOR_PRIVACY_FILE!, "thread")).toBe("full");
});

it("snapshots next turns, not active/duplicate generations; preferences outlive pruning", () => {
  env.TRACE_TO_LANGSMITH = "true";
  env.LANGSMITH_API_KEY = "test";
  expect(submit("first", "one").continue).toBe(true);
  submit("langsmith-tracing:mute", "control");
  submit("private", "two");
  submit("langsmith-tracing:unmute", "control2");
  submit("duplicate must not overwrite", "two");
  submit("third", "three");
  const turns = loadState(env.LANGSMITH_CURSOR_STATE_FILE!).thread.turns;
  expect(Object.keys(turns)).toEqual(["one", "two", "three"]);
  expect(Object.values(turns).map((t) => t.tracingMode)).toEqual(["full", "metadata", "full"]);
  expect(turns.two.prompt).toBe("private");
  submit("langsmith-tracing:mute");
  rmSync(env.LANGSMITH_CURSOR_STATE_FILE!);
  submit("after pruning", "four");
  expect(loadState(env.LANGSMITH_CURSOR_STATE_FILE!).thread.turns.four.tracingMode).toBe(
    "metadata",
  );
});

it("records the project and repo the turn was launched in", () => {
  env.TRACE_TO_LANGSMITH = "true";
  env.LANGSMITH_API_KEY = "test";
  env.LANGSMITH_CURSOR_PROJECT = "the-window-that-typed-it";

  submit("launched here", "one");

  const origin = loadState(env.LANGSMITH_CURSOR_STATE_FILE!).thread.turns.one.origin;
  expect(origin?.project).toBe("the-window-that-typed-it");
  expect(origin?.customMetadata?.cwd).toBe(dir);
});

it("blocks both controls on corrupt preference; ordinary work gets metadata fallback", () => {
  env.TRACE_TO_LANGSMITH = "true";
  env.LANGSMITH_API_KEY = "test";
  writeFileSync(env.LANGSMITH_CURSOR_PRIVACY_FILE!, "broken");
  for (const command of ["mute", "unmute"]) {
    expect(submit(`langsmith-tracing:${command}`).continue).toBe(false);
    expect(readFileSync(env.LANGSMITH_CURSOR_PRIVACY_FILE!, "utf8")).toBe("broken");
  }
  expect(submit("work").continue).toBe(true);
  expect(loadState(env.LANGSMITH_CURSOR_STATE_FILE!).thread.turns.generation.tracingMode).toBe(
    "metadata",
  );
});

it("refuses to accept a launch when the transient state cannot be written", () => {
  mkdirSync(env.LANGSMITH_CURSOR_STATE_FILE!);
  expect(submit("work").continue).toBe(false);
});

/** Execute the actual registered Stop/event through the checked-in guard bundle. */
function event(name: string, generation_id = "generation", extra: Record<string, unknown> = {}) {
  const hooks = JSON.parse(readFileSync(new URL("../hooks.json", import.meta.url), "utf8"));
  const match = /^node BUNDLE_DIR\/guard.js ([a-z-]+)$/.exec(hooks.hooks[name][0].command);
  expect(match).not.toBeNull();
  const result = spawnSync(
    process.execPath,
    [new URL("../bundle/guard.js", import.meta.url).pathname, match![1]],
    {
      cwd: dir,
      env,
      encoding: "utf8",
      timeout: 10000,
      input: JSON.stringify({
        conversation_id: "thread",
        generation_id,
        model: "default",
        hook_event_name: name,
        workspace_roots: [dir],
        ...extra,
      }),
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return result;
}

it.each(["master-off", "no-credentials"] as const)(
  "registered Stop consumes off generations with %s, without uploads/enrichment or resurrection",
  (disabled) => {
    // Preload tripwires in fresh bundle processes: no network or Cursor DB access is allowed.
    const tripwire = join(dir, "tripwire.mjs");
    writeFileSync(
      tripwire,
      `
      import { appendFileSync } from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import sqlite from "node:sqlite";
      const fail = () => { appendFileSync(${JSON.stringify(join(dir, "unexpected-io"))}, "IO"); throw new Error("Unexpected upload/enrichment"); };
      globalThis.fetch = fail;
      sqlite.DatabaseSync = class { constructor() { fail(); } };
      syncBuiltinESMExports();
    `,
    );
    env.NODE_OPTIONS = `--import=${tripwire}`;
    env.LANGSMITH_CURSOR_DB_PATH = join(dir, "cursor.db");
    writeFileSync(env.LANGSMITH_CURSOR_DB_PATH, "tripwire DB");
    if (disabled === "master-off") env.LANGSMITH_API_KEY = "test";
    else env.TRACE_TO_LANGSMITH = "true";
    // Ordinary disabled Stop without a launch is also a no-upload no-op.
    event("stop", "missing");
    expect(loadState(env.LANGSMITH_CURSOR_STATE_FILE!)).toEqual({});
    submit("OFF_PRIVATE", "one");
    submit("OFF_PRIVATE", "two");
    let state = loadState(env.LANGSMITH_CURSOR_STATE_FILE!);
    expect(Object.values(state.thread.turns).map((t) => t.tracingMode)).toEqual(["off", "off"]);
    event("stop", "one", { status: "completed" });
    state = loadState(env.LANGSMITH_CURSOR_STATE_FILE!);
    expect(Object.keys(state.thread.turns)).toEqual(["two"]);
    expect(state.thread.turn_count).toBe(1);
    expect(state.thread.completedOffGenerations).toEqual(["one"]);
    event("stop", "one");
    expect(loadState(env.LANGSMITH_CURSOR_STATE_FILE!)).toEqual(state);
    event("stop", "two");
    expect(loadState(env.LANGSMITH_CURSOR_STATE_FILE!).thread.turns).toEqual({});
    // Enable upload later: delayed hooks and duplicate submission still cannot recreate content.
    env.TRACE_TO_LANGSMITH = "true";
    env.LANGSMITH_API_KEY = "test";
    submit("LATE_PRIVATE", "one");
    event("afterAgentResponse", "one", { text: "LATE_PRIVATE" });
    event("postToolUse", "one", {
      tool_name: "Read",
      tool_use_id: "late",
      tool_input: { path: "LATE_PRIVATE" },
      tool_output: "LATE_PRIVATE",
    });
    event("postToolUseFailure", "one", {
      tool_name: "Read",
      tool_use_id: "late-error",
      tool_input: {},
      error_message: "LATE_PRIVATE",
    });
    event("subagentStart", "one", {
      subagent_id: "late-sub",
      subagent_type: "explore",
      task: "LATE_PRIVATE",
    });
    event("stop", "one");
    state = loadState(env.LANGSMITH_CURSOR_STATE_FILE!);
    expect(state.thread.turns).toEqual({});
    expect(state.thread.turn_count).toBe(2);
    expect(JSON.stringify(state)).not.toContain("PRIVATE");
    // Do not change the pre-existing lifecycle for enabled launches when uploads
    // are later disabled: this cleanup path is deliberately off-snapshot-only.
    submit("public", "full");
    const beforeDisabledStop = loadState(env.LANGSMITH_CURSOR_STATE_FILE!);
    if (disabled === "master-off") env.TRACE_TO_LANGSMITH = "false";
    else delete env.LANGSMITH_API_KEY;
    event("stop", "full");
    expect(loadState(env.LANGSMITH_CURSOR_STATE_FILE!)).toEqual(beforeDisabledStop);
    expect(() => readFileSync(join(dir, "unexpected-io"))).toThrow();
  },
  15000,
);

it("a newly muted preference does not mute an explicitly proven full subagent launch", () => {
  env.TRACE_TO_LANGSMITH = "true";
  env.LANGSMITH_API_KEY = "test";
  submit("full launch", "one");
  submit("langsmith-tracing:mute", "control");
  event("subagentStart", "one", {
    subagent_id: "sub",
    subagent_type: "explore",
    task: "full task",
  });
  const turn = loadState(env.LANGSMITH_CURSOR_STATE_FILE!).thread.turns.one;
  expect(turn.tracingMode).toBe("full");
  expect(turn.subagents[0].tracingMode).toBe("full");
  expect(getThreadTracingMode(env.LANGSMITH_CURSOR_PRIVACY_FILE!, "thread")).toBe("metadata");
});

it("config changes affect only new unoverridden generations and preserve child launches", () => {
  env.TRACE_TO_LANGSMITH = "true";
  env.LANGSMITH_API_KEY = "test";
  env.LANGSMITH_CURSOR_DEFAULT_MUTED = "true";
  submit("private", "one");
  event("subagentStart", "one", { subagent_id: "muted-sub", subagent_type: "explore" });
  env.LANGSMITH_CURSOR_DEFAULT_MUTED = "false";
  submit("duplicate", "one");
  submit("public", "two");
  env.LANGSMITH_CURSOR_DEFAULT_MUTED = "true";
  event("subagentStart", "two", { subagent_id: "full-sub", subagent_type: "explore" });
  const turns = loadState(env.LANGSMITH_CURSOR_STATE_FILE!).thread.turns;
  expect(turns.one.tracingMode).toBe("metadata");
  expect(turns.one.subagents[0].tracingMode).toBe("metadata");
  expect(turns.two.tracingMode).toBe("full");
  expect(turns.two.subagents[0].tracingMode).toBe("full");
  expect(existsSync(env.LANGSMITH_CURSOR_PRIVACY_FILE!)).toBe(false);

  submit("langsmith-tracing:unmute", "control");
  submit("explicit full", "three");
  expect(loadState(env.LANGSMITH_CURSOR_STATE_FILE!).thread.turns.three.tracingMode).toBe("full");
  submit("langsmith-tracing:mute", "control");
  env.LANGSMITH_CURSOR_DEFAULT_MUTED = "false";
  submit("explicit mute", "four");
  expect(loadState(env.LANGSMITH_CURSOR_STATE_FILE!).thread.turns.four.tracingMode).toBe(
    "metadata",
  );
  expect(JSON.parse(readFileSync(env.LANGSMITH_CURSOR_PRIVACY_FILE!, "utf8"))).toEqual({
    threads: { thread: "metadata" },
  });
});

it("uses payload workspace config rather than hook cwd, with per-field env fallthrough", () => {
  env.TRACE_TO_LANGSMITH = "true";
  env.LANGSMITH_API_KEY = "test";
  delete env.LANGSMITH_CURSOR_DEFAULT_MUTED;
  mkdirSync(join(dir, ".cursor"));
  writeFileSync(join(dir, ".cursor", "langsmith.json"), JSON.stringify({ defaultMuted: true }));
  const hookCwd = join(dir, "hook-install");
  mkdirSync(hookCwd);
  expect(submit("project mute", "generation", hookCwd).continue).toBe(true);
  expect(loadState(env.LANGSMITH_CURSOR_STATE_FILE!).thread.turns.generation.tracingMode).toBe(
    "metadata",
  );
  expect(existsSync(env.LANGSMITH_CURSOR_PRIVACY_FILE!)).toBe(false);
});

it("registered hooks honor workspace root master-off over user and harness over root without env", () => {
  delete env.TRACE_TO_LANGSMITH;
  env.LANGSMITH_API_KEY = "test";
  delete env.LANGSMITH_CURSOR_DEFAULT_MUTED;
  const userHome = join(dir, "user");
  mkdirSync(join(userHome, ".cursor"), { recursive: true });
  env.HOME = userHome;
  env.USERPROFILE = userHome;
  writeFileSync(join(userHome, ".cursor", "langsmith.json"), JSON.stringify({ enabled: true }));
  const rootConfig = join(dir, "langsmith-plugins.json");
  writeFileSync(rootConfig, JSON.stringify({ enabled: false, defaultMuted: true }));
  const hookCwd = join(dir, "hook-install");
  mkdirSync(hookCwd);
  writeFileSync(
    join(hookCwd, "langsmith-plugins.json"),
    JSON.stringify({ enabled: true, defaultMuted: false }),
  );
  env.CURSOR_PROJECT_DIR = hookCwd;
  expect(submit("root off", "off", hookCwd).continue).toBe(true);
  expect(loadState(env.LANGSMITH_CURSOR_STATE_FILE!).thread.turns.off.tracingMode).toBe("off");
  // Root master-off must suppress Stop uploads as well as prompt snapshots.
  const tripwire = join(dir, "root-tripwire.mjs");
  writeFileSync(
    tripwire,
    `
    import { appendFileSync } from "node:fs";
    globalThis.fetch = () => { appendFileSync(${JSON.stringify(join(dir, "unexpected-upload"))}, "upload"); throw new Error("Unexpected upload"); };
  `,
  );
  env.NODE_OPTIONS = `--import=${tripwire}`;
  event("stop", "off", { status: "completed" });
  expect(loadState(env.LANGSMITH_CURSOR_STATE_FILE!).thread.turns).toEqual({});
  mkdirSync(join(dir, ".cursor"));
  writeFileSync(join(dir, ".cursor", "langsmith.json"), JSON.stringify({ enabled: true }));
  submit("root default mute", "muted", hookCwd);
  expect(loadState(env.LANGSMITH_CURSOR_STATE_FILE!).thread.turns.muted.tracingMode).toBe(
    "metadata",
  );
  writeFileSync(
    join(dir, ".cursor", "langsmith.json"),
    JSON.stringify({ enabled: true, defaultMuted: false }),
  );
  submit("harness wins", "full", hookCwd);
  expect(loadState(env.LANGSMITH_CURSOR_STATE_FILE!).thread.turns.full.tracingMode).toBe("full");
  rmSync(join(dir, ".cursor", "langsmith.json"));
  const beforeStop = loadState(env.LANGSMITH_CURSOR_STATE_FILE!);
  event("stop", "full", { status: "completed" });
  expect(loadState(env.LANGSMITH_CURSOR_STATE_FILE!)).toEqual(beforeStop);
  expect(existsSync(join(dir, "unexpected-upload"))).toBe(false);
});

it.each([JSON.stringify({ enabled: false, defaultMuted: true }), "{malformed"])(
  "registered prompt hook ignores old root langsmith.json: %s",
  (raw) => {
    env.TRACE_TO_LANGSMITH = "true";
    env.LANGSMITH_API_KEY = "test";
    env.LANGSMITH_CURSOR_DEFAULT_MUTED = "false";
    writeFileSync(join(dir, "langsmith.json"), raw);
    submit("old app config ignored", "old");
    expect(loadState(env.LANGSMITH_CURSOR_STATE_FILE!).thread.turns.old.tracingMode).toBe("full");
    writeFileSync(join(dir, "langsmith-plugins.json"), JSON.stringify({ enabled: false }));
    submit("environment intentionally overrides root", "env");
    expect(loadState(env.LANGSMITH_CURSOR_STATE_FILE!).thread.turns.env.tracingMode).toBe("full");
    delete env.TRACE_TO_LANGSMITH;
    submit("new root honored", "root");
    expect(loadState(env.LANGSMITH_CURSOR_STATE_FILE!).thread.turns.root.tracingMode).toBe("off");
    mkdirSync(join(dir, ".cursor"));
    writeFileSync(join(dir, ".cursor", "langsmith.json"), JSON.stringify({ enabled: true }));
    submit("harness overrides root", "harness");
    expect(loadState(env.LANGSMITH_CURSOR_STATE_FILE!).thread.turns.harness.tracingMode).toBe(
      "full",
    );
  },
);

it.each([JSON.stringify({ enabled: true, defaultMuted: true }), "{malformed"])(
  "registered prompt hook uses hidden home only, preserving the cascade: %s",
  (raw) => {
    delete env.TRACE_TO_LANGSMITH;
    delete env.LANGSMITH_CURSOR_DEFAULT_MUTED;
    env.LANGSMITH_API_KEY = "test";
    const home = join(dir, "user-home");
    mkdirSync(home);
    env.HOME = home;
    env.USERPROFILE = home;
    writeFileSync(join(home, "langsmith-plugins.json"), raw);
    const mode = (generation: string) =>
      loadState(env.LANGSMITH_CURSOR_STATE_FILE!).thread.turns[generation].tracingMode;
    submit("old home ignored", "old-home");
    expect(mode("old-home")).toBe("off");
    writeFileSync(
      join(home, ".langsmith-plugins.json"),
      JSON.stringify({ enabled: true, defaultMuted: true }),
    );
    submit("hidden home honored", "hidden-home");
    expect(mode("hidden-home")).toBe("metadata");
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".cursor", "langsmith.json"), JSON.stringify({ defaultMuted: false }));
    submit("Cursor user wins", "user");
    expect(mode("user")).toBe("full");
    writeFileSync(join(dir, "langsmith-plugins.json"), JSON.stringify({ defaultMuted: true }));
    submit("visible project wins", "project");
    expect(mode("project")).toBe("metadata");
    mkdirSync(join(dir, ".cursor"));
    writeFileSync(join(dir, ".cursor", "langsmith.json"), JSON.stringify({ defaultMuted: false }));
    submit("Cursor project wins", "harness");
    expect(mode("harness")).toBe("full");
    env.LANGSMITH_CURSOR_DEFAULT_MUTED = "true";
    submit("environment wins", "env");
    expect(mode("env")).toBe("metadata");
  },
);
