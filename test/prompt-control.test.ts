import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { getThreadTracingMode } from "../src/tracing-policy.js";
import { loadState } from "./utils/state.js";
import { PLUGIN_DIRECTORY_NAME } from "./utils/plugin-layout.js";
import { MIN_NODE } from "../src/utils/node-version.js";

vi.mock("@langchain/plugins-base/auth", { spy: true });
vi.mock("@langchain/plugins-base/settings", { spy: true });

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
  return submitWith({ prompt, generation_id, cwd });
}

function submitWith({
  prompt,
  generation_id = "generation",
  cwd = dir,
  workspace = dir,
}: {
  prompt: string;
  generation_id?: string;
  cwd?: string;
  workspace?: string;
}) {
  const hooks = JSON.parse(
    readFileSync(new URL(`../${PLUGIN_DIRECTORY_NAME}/hooks/hooks.json`, import.meta.url), "utf8"),
  );
  const registration = hooks.hooks.beforeSubmitPrompt[0];
  expect(registration).toMatchObject({ timeout: 15 });
  const match = /langsmith-tracing\.cmd" (before-submit-prompt)$/.exec(registration.command);
  expect(match).not.toBeNull();
  const result = spawnSync(
    process.execPath,
    [new URL(`../${PLUGIN_DIRECTORY_NAME}/bundle/guard.js`, import.meta.url).pathname, match![1]],
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
        workspace_roots: [workspace],
      }),
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

it("registers the blocking contract on the one entry the plugin owns", () => {
  const plugin = JSON.parse(
    readFileSync(new URL(`../${PLUGIN_DIRECTORY_NAME}/hooks/hooks.json`, import.meta.url), "utf8"),
  );
  expect(plugin.hooks.beforeSubmitPrompt).toHaveLength(1);
  expect(plugin.hooks.beforeSubmitPrompt[0]).toMatchObject({ timeout: 15 });
  expect(plugin.hooks.beforeSubmitPrompt[0].command).toContain(
    '${CURSOR_PLUGIN_ROOT}/binary/langsmith-tracing.cmd" before-submit-prompt',
  );
});

function raw(input: string) {
  return spawnSync(
    process.execPath,
    [
      new URL(`../${PLUGIN_DIRECTORY_NAME}/bundle/guard.js`, import.meta.url).pathname,
      "before-submit-prompt",
    ],
    { cwd: dir, env, encoding: "utf8", timeout: 10000, input },
  );
}

it("lets the prompt through when the event cannot be read at all", () => {
  const result = raw("not an event at all");
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).continue).toBe(true);
});

it("lets the prompt through when Node is too old to trace", () => {
  const shim = join(dir, "old-node.mjs");
  const tooOld = `${MIN_NODE[0]}.${MIN_NODE[1] - 1}.0`;
  writeFileSync(shim, `Object.defineProperty(process.versions,"node",{value:"${tooOld}"});\n`);
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(shim).href,
      new URL(`../${PLUGIN_DIRECTORY_NAME}/bundle/guard.js`, import.meta.url).pathname,
      "before-submit-prompt",
    ],
    { cwd: dir, env, encoding: "utf8", timeout: 10000, input: "{}" },
  );
  expect(result.stderr).toContain("node:sqlite");
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).continue).toBe(true);
});

it("lets the prompt through when the hook itself cannot be loaded", () => {
  const alone = mkdtempSync(join(tmpdir(), "cursor alone "));
  cpSync(
    new URL(`../${PLUGIN_DIRECTORY_NAME}/bundle/guard.js`, import.meta.url).pathname,
    join(alone, "guard.js"),
  );
  const result = spawnSync(process.execPath, [join(alone, "guard.js"), "before-submit-prompt"], {
    cwd: dir,
    env,
    encoding: "utf8",
    timeout: 10000,
    input: "{}",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).continue).toBe(true);
});

it("never asks Cursor to refuse a prompt because tracing could not start", () => {
  const manifests = [
    JSON.parse(
      readFileSync(
        new URL(`../${PLUGIN_DIRECTORY_NAME}/hooks/hooks.json`, import.meta.url),
        "utf8",
      ),
    ),
  ];
  for (const manifest of manifests) {
    for (const entries of Object.values(manifest.hooks) as { failClosed?: boolean }[][]) {
      for (const entry of entries) expect(entry.failClosed).toBeUndefined();
    }
  }
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

it("lets the prompt through when the transient state cannot be written", () => {
  mkdirSync(env.LANGSMITH_CURSOR_STATE_FILE!);
  expect(submit("work").continue).toBe(true);
});

/** Execute the actual registered Stop/event through the checked-in guard bundle. */
function event(name: string, generation_id = "generation", extra: Record<string, unknown> = {}) {
  const hooks = JSON.parse(
    readFileSync(new URL(`../${PLUGIN_DIRECTORY_NAME}/hooks/hooks.json`, import.meta.url), "utf8"),
  );
  const match = /langsmith-tracing\.cmd" ([a-z-]+)$/.exec(hooks.hooks[name][0].command);
  expect(match).not.toBeNull();
  const result = spawnSync(
    process.execPath,
    [new URL(`../${PLUGIN_DIRECTORY_NAME}/bundle/guard.js`, import.meta.url).pathname, match![1]],
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
      import childProcess from "node:child_process";
      import { appendFileSync } from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import sqlite from "node:sqlite";
      const fail = () => { appendFileSync(${JSON.stringify(join(dir, "unexpected-io"))}, "IO"); throw new Error("Unexpected upload/enrichment"); };
      globalThis.fetch = fail;
      sqlite.DatabaseSync = class { constructor() { fail(); } };
      const spawn = childProcess.spawn;
      childProcess.spawn = (command, ...rest) => {
        if (!/(osascript|powershell\\.exe|notify-send)$/.test(command)) return spawn(command, ...rest);
        throw new Error("No desktop notifications in tests");
      };
      syncBuiltinESMExports();
    `,
    );
    env.NODE_OPTIONS = `--import=${tripwire}`;
    env.LANGSMITH_CURSOR_DB_PATH = join(dir, "cursor.db");
    writeFileSync(env.LANGSMITH_CURSOR_DB_PATH, "tripwire DB");
    if (disabled === "master-off") env.LANGSMITH_API_KEY = "test";
    else
      Object.assign(env, { TRACE_TO_LANGSMITH: "true", LANGSMITH_CURSOR_NOTICE_COOLDOWN: "off" });
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

it.skipIf(process.platform === "win32")(
  "never holds back a prompt for a broken managed file, and names it in a mute reply",
  async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.resetModules();
    const { handlePromptSubmit } = await import("../src/prompt-control.js");
    const prompt = (conversation_id: string, generation_id: string, text = "work") =>
      handlePromptSubmit({
        conversation_id,
        generation_id,
        prompt: text,
        model: "default",
        hook_event_name: "beforeSubmitPrompt",
        workspace_roots: [dir],
      });
    const managed = join(env.LS_TEST_ACCOUNT_HOME!, ".langsmith-plugins");
    mkdirSync(managed, { recursive: true });
    writeFileSync(join(managed, "managed.json"), "{}");
    try {
      expect(await prompt("thread", "first")).toEqual({ continue: true });
      expect(await prompt("thread", "second")).toEqual({ continue: true });
      const reply = await prompt("thread", "control", "langsmith-tracing:mute");
      expect(reply.user_message).toContain("owned by root");
      expect(reply.user_message).not.toContain("Master tracing is disabled");
    } finally {
      rmSync(join(managed, "managed.json"));
      vi.unstubAllEnvs();
    }
  },
);

async function withLogin(extraEnv: Record<string, string>, loginNotice?: string) {
  for (const key of Object.keys(process.env)) {
    if (/^(LANGSMITH_|LANGCHAIN_)/.test(key)) vi.stubEnv(key, undefined);
  }
  for (const [key, value] of Object.entries({ ...env, TRACE_TO_LANGSMITH: "true", ...extraEnv }))
    vi.stubEnv(key, value);
  vi.stubEnv("LANGSMITH_CONFIG_FILE", join(dir, "login.json"));
  writeFileSync(
    join(dir, "login.json"),
    JSON.stringify({ profiles: { default: { oauth: { refresh_token: "t" } } } }),
  );
  vi.resetModules();
  const auth = await import("@langchain/plugins-base/auth");
  const { handlePromptSubmit } = await import("../src/prompt-control.js");
  const { initHook } = await import("../src/utils/hook-init.js");
  vi.mocked(auth.readLoginNotice).mockReturnValue(loginNotice);
  const prompt = (conversation_id: string, generation_id: string, text = "work") =>
    handlePromptSubmit({
      conversation_id,
      generation_id,
      prompt: text,
      model: "default",
      hook_event_name: "beforeSubmitPrompt",
      workspace_roots: [dir],
    });
  return { initHook, prompt };
}

const held = (message: unknown) => ({ continue: false, user_message: message });
const logged = () => readFileSync(join(dir, "hook.log"), "utf8");

afterEach(() => {
  vi.unstubAllEnvs();
});

it("lets every prompt through for an expired CLI login and only logs why", async () => {
  const { initHook, prompt } = await withLogin({}, "login paused");
  expect(await prompt("thread", "first")).toEqual({ continue: true });
  expect(await prompt("thread", "second")).toEqual({ continue: true });
  expect(initHook(dir)).not.toBeNull();
  const turns = loadState(env.LANGSMITH_CURSOR_STATE_FILE!).thread.turns;
  expect(Object.keys(turns)).toEqual(["first", "second"]);
  expect(turns.second.tracingMode).toBe("full");
  expect(logged()).toContain("login paused");
});

it("holds back every prompt in strict mode until the user signs in again", async () => {
  const { prompt } = await withLogin({ LANGSMITH_CURSOR_STRICT_AUTH: "true" }, "login paused");
  expect(await prompt("thread", "first")).toEqual(held("login paused"));
  expect(await prompt("thread", "second")).toEqual(held("login paused"));
  const { readLoginNotice } = await import("@langchain/plugins-base/auth");
  vi.mocked(readLoginNotice).mockReturnValue(undefined);
  expect(await prompt("thread", "third")).toEqual({ continue: true });
});

it("holds back every prompt in strict mode when nothing can upload", async () => {
  const { prompt } = await withLogin({
    LANGSMITH_CURSOR_STRICT_AUTH: "true",
    LANGSMITH_CURSOR_RUNS_ENDPOINTS: JSON.stringify([{ api_url: "https://replica.test" }]),
  });
  const refused = held(expect.stringContaining("https://replica.test"));
  expect(await prompt("thread", "first")).toEqual(refused);
  expect(await prompt("thread", "second")).toEqual(refused);
});

it("holds back every prompt in a muted conversation in strict mode", async () => {
  const { prompt } = await withLogin({ LANGSMITH_CURSOR_STRICT_AUTH: "true" }, "login paused");
  await prompt("thread", "mute", "langsmith-tracing:mute");
  expect(await prompt("thread", "first")).toEqual(held("login paused"));
  expect(await prompt("thread", "second")).toEqual(held("login paused"));
});

it("stays quiet about the login while tracing is off", async () => {
  const { prompt } = await withLogin({ TRACE_TO_LANGSMITH: "false" }, "login paused");
  expect(await prompt("thread", "first")).toEqual({ continue: true });
});

it("ignores an expired login when every upload goes to a replica with its own key", async () => {
  const { prompt } = await withLogin(
    {
      LANGSMITH_CURSOR_STRICT_AUTH: "true",
      LANGSMITH_CURSOR_RUNS_ENDPOINTS: JSON.stringify([
        { api_url: "https://replica.test", api_key: "replica-key" },
      ]),
    },
    "login paused",
  );
  expect(await prompt("thread", "first")).toEqual({ continue: true });
});

it("checks the rejected-key notice only for the API key in use", async () => {
  const { prompt } = await withLogin(
    { LANGSMITH_CURSOR_API_KEY: "key", LANGSMITH_CURSOR_ENDPOINT: "https://ls.test" },
    "key rejected",
  );
  const { readLoginNotice } = await import("@langchain/plugins-base/auth");
  expect(await prompt("thread", "first")).toEqual({ continue: true });
  expect(logged()).toContain("key rejected");
  expect(vi.mocked(readLoginNotice).mock.calls.at(-1)?.[2]).toEqual({
    apiKey: "key",
    apiUrl: "https://ls.test",
  });
});

it("never asks about a rejected key for someone signed in with the CLI", async () => {
  const { prompt } = await withLogin({}, "login paused");
  const { readLoginNotice } = await import("@langchain/plugins-base/auth");
  await prompt("thread", "first");
  expect(vi.mocked(readLoginNotice).mock.calls.at(-1)?.[2]).toBeUndefined();
});

it("checks the expired-login notice for the configured profile", async () => {
  const { prompt } = await withLogin({}, "login paused");
  const { readLoginNotice } = await import("@langchain/plugins-base/auth");
  writeFileSync(
    join(dir, "login.json"),
    JSON.stringify({ profiles: { work: { oauth: { refresh_token: "t" } } } }),
  );
  writeFileSync(join(dir, "langsmith-plugins.json"), JSON.stringify({ profile: "work" }));
  await prompt("thread", "first");
  expect(vi.mocked(readLoginNotice).mock.calls.at(-1)?.[3]).toBe("work");
});

it.skipIf(process.platform === "win32")(
  "names a broken managed file before an expired login",
  async () => {
    const { prompt } = await withLogin({}, "login paused");
    const managed = join(env.LS_TEST_ACCOUNT_HOME!, ".langsmith-plugins");
    mkdirSync(managed, { recursive: true });
    writeFileSync(join(managed, "managed.json"), "{}");
    try {
      expect(await prompt("thread", "first")).toEqual({ continue: true });
      expect(logged()).toContain("owned by root");
      expect(logged()).not.toContain("login paused");
    } finally {
      rmSync(join(managed, "managed.json"));
    }
  },
);

it.skipIf(process.platform === "win32")(
  "never holds back a prompt in strict mode over a broken managed file",
  async () => {
    const { prompt } = await withLogin({ LANGSMITH_CURSOR_STRICT_AUTH: "true" });
    rmSync(join(dir, "login.json"));
    const managed = join(env.LS_TEST_ACCOUNT_HOME!, ".langsmith-plugins");
    mkdirSync(managed, { recursive: true });
    writeFileSync(join(managed, "managed.json"), "{}");
    try {
      expect(await prompt("thread", "first")).toEqual({ continue: true });
    } finally {
      rmSync(join(managed, "managed.json"));
    }
  },
);

it.skipIf(process.platform === "win32")(
  "tells setup about a broken managed file instead of a sign-in",
  async () => {
    const { prompt } = await withLogin({});
    const managed = join(env.LS_TEST_ACCOUNT_HOME!, ".langsmith-plugins");
    mkdirSync(managed, { recursive: true });
    writeFileSync(join(managed, "managed.json"), "{}");
    try {
      const signedIn = await prompt("thread", "setup", "langsmith-tracing:setup");
      expect(signedIn.user_message).toContain("owned by root");
      expect(signedIn.user_message).not.toContain("Signed in");
      rmSync(join(dir, "login.json"));
      const noCredential = await prompt("thread", "setup2", "langsmith-tracing:setup");
      expect(noCredential.user_message).toContain("owned by root");
      expect(noCredential.user_message).not.toContain("Using your LangSmith API key");
    } finally {
      rmSync(join(managed, "managed.json"));
    }
  },
);

it("stops tracing and names keyless replicas the login can't reach", async () => {
  const { initHook, prompt } = await withLogin({
    LANGSMITH_CURSOR_RUNS_ENDPOINTS: JSON.stringify([{ api_url: "https://replica.test" }]),
  });
  expect(await prompt("thread", "first")).toEqual({ continue: true });
  expect(logged()).toContain("https://replica.test");
  expect(await prompt("thread", "second")).toEqual({ continue: true });
  expect(initHook(dir)).toBeNull();
  expect(loadState(env.LANGSMITH_CURSOR_STATE_FILE!).thread.turns.second.tracingMode).toBe("off");
});

it("keeps a conversation muted when the managed file locks muting on", async () => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubEnv("TRACE_TO_LANGSMITH", "true");
  vi.stubEnv("LANGSMITH_API_KEY", "key");
  vi.resetModules();
  const settings = await import("@langchain/plugins-base/settings");
  const actual = await vi.importActual<typeof settings>("@langchain/plugins-base/settings");
  vi.mocked(settings.readCommonConfigFiles).mockImplementation((options) => ({
    ...actual.readCommonConfigFiles(options),
    managed: { status: "valid", common: { defaultMuted: true }, raw: {}, diagnostics: [] },
  }));
  const { setThreadTracingMode, tracingPolicyPath } = await import("../src/tracing-policy.js");
  const { handlePromptSubmit } = await import("../src/prompt-control.js");
  const prompt = (prompt: string, generation_id: string) =>
    handlePromptSubmit({
      conversation_id: "thread",
      generation_id,
      prompt,
      model: "default",
      hook_event_name: "beforeSubmitPrompt",
      workspace_roots: [dir],
    });
  try {
    await setThreadTracingMode(tracingPolicyPath(), "thread", "full");
    expect((await prompt("langsmith-tracing:unmute", "control")).user_message).toContain(
      "admin locked",
    );
    expect((await prompt("langsmith-tracing:mute", "control2")).user_message).toContain("muted");
    await setThreadTracingMode(tracingPolicyPath(), "thread", "full");
    await prompt("work", "one");
    expect(loadState(env.LANGSMITH_CURSOR_STATE_FILE!).thread.turns.one.tracingMode).toBe(
      "metadata",
    );
    await setThreadTracingMode(tracingPolicyPath(), "thread", "full");
    expect((await prompt("langsmith-tracing:setup", "setup")).user_message).toContain(
      "This thread is muted",
    );
  } finally {
    vi.mocked(settings.readCommonConfigFiles).mockRestore();
    vi.unstubAllEnvs();
  }
});

it.each(['""', "   ", '" "'])(
  "treats the API key %s as missing so tracing stays off",
  async (key) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    vi.stubEnv("TRACE_TO_LANGSMITH", "true");
    vi.stubEnv("LANGSMITH_API_KEY", key);
    vi.resetModules();
    const { handlePromptSubmit } = await import("../src/prompt-control.js");
    const { initHook } = await import("../src/utils/hook-init.js");
    const submit = (generation_id: string) =>
      handlePromptSubmit({
        conversation_id: "thread",
        generation_id,
        prompt: "work",
        model: "default",
        hook_event_name: "beforeSubmitPrompt",
        workspace_roots: [dir],
      });
    try {
      expect(await submit("one")).toEqual({ continue: true });
      expect(logged()).toContain("not signed in to LangSmith");
      expect(await submit("two")).toEqual({ continue: true });
      expect(initHook(dir)).toBeNull();
      expect(loadState(env.LANGSMITH_CURSOR_STATE_FILE!).thread.turns.two.tracingMode).toBe("off");
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it("keeps tracing while a replica with its own key can still upload", async () => {
  const { initHook } = await withLogin({
    LANGSMITH_CURSOR_RUNS_ENDPOINTS: JSON.stringify([
      { api_url: "https://replica.test" },
      { api_url: "https://keyed.test", api_key: "key" },
    ]),
  });
  expect(initHook(dir)).not.toBeNull();
});

it("writes setup to the home config and reports what the workspace config overrides", () => {
  env.LANGSMITH_CURSOR_ENDPOINT = "http://127.0.0.1:9";
  const workspace = join(dir, "workspace");
  mkdirSync(join(workspace, ".cursor"), { recursive: true });
  writeFileSync(join(workspace, ".cursor", "langsmith.json"), '{"project":"from-repo"}');
  const path = join(dir, ".cursor", "langsmith.json");
  const response = submitWith({
    prompt: "langsmith-tracing:setup mine https://example.test",
    workspace,
  });
  expect(response.continue).toBe(false);
  expect(response.user_message).toContain(
    `Turned LangSmith tracing on in ${path}. Traces go to the "from-repo" project at "http://127.0.0.1:9". Tracing is still off because`,
  );
  expect(response.user_message).toContain("LANGSMITH TRACING IS PAUSED");
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    enabled: true,
    project: "mine",
    api_url: "https://example.test",
  });
  expect(readFileSync(join(workspace, ".cursor", "langsmith.json"), "utf8")).toBe(
    '{"project":"from-repo"}',
  );
  expect(existsSync(env.LANGSMITH_CURSOR_STATE_FILE!)).toBe(false);
});

it("turns tracing on from setup with no arguments", () => {
  const response = submit("langsmith-tracing:setup");
  expect(response.continue).toBe(false);
  expect(JSON.parse(readFileSync(join(dir, ".cursor", "langsmith.json"), "utf8"))).toEqual({
    enabled: true,
  });
});

it("keeps every other key when setup saves a project and server", () => {
  delete env.TRACE_TO_LANGSMITH;
  const path = join(dir, ".cursor", "langsmith.json");
  mkdirSync(join(dir, ".cursor"));
  writeFileSync(path, JSON.stringify({ api_key: "lsv2_pt_test", redact: false }));
  const response = submit("langsmith-tracing:setup my project http://127.0.0.1:1980");
  expect(response).toEqual({
    continue: false,
    user_message: `Turned LangSmith tracing on in ${path}. Traces go to the "my project" project at "http://127.0.0.1:1980". Using your LangSmith API key.`,
  });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    api_key: "lsv2_pt_test",
    redact: false,
    enabled: true,
    project: "my project",
    api_url: "http://127.0.0.1:1980",
  });
});

it("refuses setup with a second line and saves nothing", () => {
  const refused = {
    continue: false,
    user_message:
      "Setup takes its project and URL on one line, so nothing was changed. Send anything else as its own message.",
  };
  expect(submit("langsmith-tracing:setup myproj\n\nAlso fix foo.ts")).toEqual(refused);
  expect(submit("langsmith-tracing:setup\nmyproj")).toEqual(refused);
  expect(existsSync(join(dir, ".cursor", "langsmith.json"))).toBe(false);
});

it("refuses setup with a typed API key and leaves the config alone", () => {
  const path = join(dir, ".cursor", "langsmith.json");
  mkdirSync(join(dir, ".cursor"));
  writeFileSync(path, '{"project":"before"}');
  expect(submit("langsmith-tracing:setup lsv2_pt_typed")).toEqual({
    continue: false,
    user_message:
      "That looks like a LangSmith API key, so nothing was changed. Put the key in your config file instead, since anything typed in chat can end up in your history and traces.",
  });
  expect(readFileSync(path, "utf8")).toBe('{"project":"before"}');
});

it("replies with the error and changes nothing when setup cannot read the config", () => {
  const path = join(dir, ".cursor", "langsmith.json");
  mkdirSync(join(dir, ".cursor"));
  writeFileSync(path, "{broken");
  expect(submit("langsmith-tracing:setup mine")).toEqual({
    continue: false,
    user_message: `Couldn't read ${path} as a JSON object, so nothing was changed. Fix or remove that file and run setup again.`,
  });
  expect(readFileSync(path, "utf8")).toBe("{broken");
});

it("treats near misses of the setup command as ordinary prompts", () => {
  for (const prompt of ["/langsmith-tracing:setup", "langsmith-tracing:setupx"]) {
    expect(submit(prompt)).toEqual({ continue: true });
  }
  expect(existsSync(join(dir, ".cursor", "langsmith.json"))).toBe(false);
});

const setupReply = (destination: string, signIn: string) =>
  held(
    `Turned LangSmith tracing on in ${join(dir, ".cursor", "langsmith.json")}. ${destination} ${signIn}`,
  );

it("tells setup about a rejected key the way the next prompt would", async () => {
  const { prompt } = await withLogin({ LANGSMITH_CURSOR_API_KEY: "key" }, "key rejected");
  expect(await prompt("thread", "setup", "langsmith-tracing:setup")).toEqual(
    setupReply(
      'Traces go to the "cursor" project at "https://api.smith.langchain.com".',
      "key rejected",
    ),
  );
});

it("tells setup that a login can't reach a keyless replica", async () => {
  const { prompt } = await withLogin({
    LANGSMITH_CURSOR_RUNS_ENDPOINTS: JSON.stringify([{ api_url: "https://replica.test" }]),
  });
  const reply = await prompt("thread", "setup", "langsmith-tracing:setup");
  expect(reply.user_message).toContain("https://replica.test");
  expect(reply.user_message).not.toContain("Signed in");
});

it("tells setup tracing is on when only a replica with its own key uploads", async () => {
  const { prompt } = await withLogin({
    LANGSMITH_CURSOR_RUNS_ENDPOINTS: JSON.stringify([
      { api_url: "https://replica.test", api_key: "key" },
    ]),
  });
  rmSync(join(dir, "login.json"));
  expect(await prompt("thread", "setup", "langsmith-tracing:setup")).toEqual(
    setupReply(
      "Traces go to the replica destination in your settings, which replaces the usual project and URL.",
      "Using your LangSmith API key.",
    ),
  );
});

it("tells setup a keyless replica doesn't count without a key or login", async () => {
  const { prompt } = await withLogin({
    LANGSMITH_CURSOR_RUNS_ENDPOINTS: JSON.stringify([
      { api_url: "https://keyed.test", api_key: "key" },
      { api_url: "https://keyless.test" },
    ]),
  });
  rmSync(join(dir, "login.json"));
  expect(await prompt("thread", "setup", "langsmith-tracing:setup")).toEqual(
    setupReply(
      "Traces go to the replica destination in your settings, which replaces the usual project and URL.",
      "Using your LangSmith API key.",
    ),
  );
});

it("tells setup the server a CLI login uploads to", async () => {
  const { prompt } = await withLogin({});
  writeFileSync(
    join(dir, "login.json"),
    JSON.stringify({
      profiles: {
        default: {
          api_url: "https://eu.api.smith.langchain.com",
          oauth: { refresh_token: "t" },
        },
      },
    }),
  );
  expect(await prompt("thread", "setup", "langsmith-tracing:setup")).toEqual(
    setupReply(
      'Traces go to the "cursor" project at "https://eu.api.smith.langchain.com".',
      "Signed in with the LangSmith CLI.",
    ),
  );
});

it("tells setup traces go to the configured agent", async () => {
  const { prompt } = await withLogin({ LANGSMITH_AGENT_ID: "shared-cursor" });
  expect(await prompt("thread", "setup", "langsmith-tracing:setup mine")).toEqual(
    setupReply(
      'Traces go to the "shared-cursor" agent at "https://api.smith.langchain.com". Another setting overrides part of this (an agent_id, an environment variable, a project\'s langsmith.json or langsmith-plugins.json, or your admin\'s managed settings), so the values above are what\'s in effect.',
      "Signed in with the LangSmith CLI.",
    ),
  );
});

it("tells setup about a paused login while tracing is switched off", async () => {
  const { prompt } = await withLogin({ TRACE_TO_LANGSMITH: "false" }, "login paused");
  const reply = await prompt("thread", "setup", "langsmith-tracing:setup");
  expect(reply.user_message).toContain("login paused");
  expect(reply.user_message).not.toContain("Signed in");
});

it("runs setup after a non-breaking space", () => {
  expect(submit("langsmith-tracing:setup\u00a0mine").continue).toBe(false);
  expect(JSON.parse(readFileSync(join(dir, ".cursor", "langsmith.json"), "utf8"))).toEqual({
    enabled: true,
    project: "mine",
  });
});

it("tells setup the thread is muted after a mute in the same thread", () => {
  submit("langsmith-tracing:mute", "control");
  expect(submit("langsmith-tracing:setup", "setup").user_message).toContain(
    "This thread is muted, so traces keep their structure and usage but not your prompts, responses or tool data.",
  );
});

it("tells setup the thread is muted when every conversation starts muted", () => {
  env.LANGSMITH_CURSOR_DEFAULT_MUTED = "true";
  expect(submit("langsmith-tracing:setup").user_message).toContain("This thread is muted");
});

it("tells setup only the replicas a login can reach replace the project", async () => {
  const { prompt } = await withLogin({
    LANGSMITH_CURSOR_RUNS_ENDPOINTS: JSON.stringify([
      { api_url: "https://keyed.test", api_key: "key" },
      { api_url: "https://api.smith.langchain.com" },
      { api_url: "https://replica.test" },
    ]),
  });
  expect(await prompt("thread", "setup", "langsmith-tracing:setup mine")).toEqual(
    setupReply(
      "Traces go to the 2 replica destinations in your settings, which replace the usual project and URL. Another setting overrides part of this (an agent_id, an environment variable, a project's langsmith.json or langsmith-plugins.json, or your admin's managed settings), so the values above are what's in effect.",
      "Signed in with the LangSmith CLI.",
    ),
  );
});

it("tells setup every replica replaces the project when an API key uploads", async () => {
  const { prompt } = await withLogin({
    LANGSMITH_CURSOR_API_KEY: "key",
    LANGSMITH_CURSOR_RUNS_ENDPOINTS: JSON.stringify([
      { api_url: "https://one.test" },
      { api_url: "https://two.test" },
    ]),
  });
  expect(await prompt("thread", "setup", "langsmith-tracing:setup")).toEqual(
    setupReply(
      "Traces go to the 2 replica destinations in your settings, which replace the usual project and URL.",
      "Using your LangSmith API key.",
    ),
  );
});
