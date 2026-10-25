import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCommonConfigFiles, type CommonConfig } from "@langchain/plugins-base/settings";
import { loadConfig } from "../src/config.js";
import * as logger from "../src/logger.js";
import { uploadCredential, writerOptions } from "../src/writer-options.js";

vi.mock("@langchain/plugins-base/settings", { spy: true });

const { readCommonConfigFiles: readFiles } = await vi.importActual<
  typeof import("@langchain/plugins-base/settings")
>("@langchain/plugins-base/settings");

const lock = (common: CommonConfig, raw: Record<string, unknown> = { ...common }) =>
  vi.mocked(readCommonConfigFiles).mockImplementationOnce((options) => ({
    ...readFiles(options),
    managed: { status: "valid", common, raw, diagnostics: [] },
  }));

afterEach(() => {
  vi.unstubAllEnvs();
});

function clearEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (/^(LANGSMITH_|LANGCHAIN_|CURSOR_PROJECT_DIR)/.test(key)) vi.stubEnv(key, undefined);
  }
  for (const k of [
    "TRACE_TO_LANGSMITH",
    "LANGSMITH_CURSOR_DEFAULT_MUTED",
    "LANGSMITH_API_KEY",
    "LANGSMITH_CURSOR_API_KEY",
    "LANGSMITH_ENDPOINT",
    "LANGSMITH_CURSOR_ENDPOINT",
    "LANGSMITH_PROJECT",
    "LANGSMITH_CURSOR_PROJECT",
    "LANGSMITH_CURSOR_DEBUG",
    "LANGSMITH_CURSOR_STATE_FILE",
    "LANGSMITH_CURSOR_REDACT",
    "LANGSMITH_CURSOR_REDACT_EXTRA",
    "LANGSMITH_CURSOR_SWEEP_IDLE_MINUTES",
  ]) {
    vi.stubEnv(k, undefined as unknown as string);
  }
}

const FILES = [
  [".langsmith-plugins.json", "home root"],
  [".cursor/langsmith.json", "user"],
  ["workspace/langsmith-plugins.json", "project root"],
  ["workspace/.cursor/langsmith.json", "project"],
] as const;

describe("loadConfig", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    clearEnv();
    home = mkdtempSync(join(tmpdir(), "cursor-config-"));
    cwd = join(home, "workspace");
    mkdirSync(join(cwd, ".cursor"), { recursive: true });
    mkdirSync(join(home, ".cursor"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  function write(index: number, value: Record<string, unknown> | string) {
    writeFileSync(
      join(home, FILES[index][0]),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  }

  it("reads the four files in order, the project's .cursor file winning and the environment above all", () => {
    FILES.forEach((_, index) =>
      write(index, { project: `file-${index}`, api_key: `key-${index}` }),
    );
    expect(loadConfig({ cwd })).toMatchObject({ project: "file-3", apiKey: "key-3" });
    for (let index = 3; index > 0; index--) {
      write(index, {});
      expect(loadConfig({ cwd })).toMatchObject({
        project: `file-${index - 1}`,
        apiKey: `key-${index - 1}`,
      });
    }
    vi.stubEnv("LANGSMITH_PROJECT", "env");
    expect(loadConfig({ cwd }).project).toBe("env");
  });

  it("defaults to disabled, the cursor project and the public endpoint", () => {
    expect(loadConfig({ cwd })).toMatchObject({
      enabled: false,
      project: "cursor",
      apiUrl: "https://api.smith.langchain.com",
      sweepIdleMinutes: 360,
      redact: true,
      attachmentsEnabled: true,
      systemPromptEnabled: true,
    });
  });

  it("uses the explicit cwd before CURSOR_PROJECT_DIR before process.cwd", () => {
    writeFileSync(join(cwd, "langsmith-plugins.json"), JSON.stringify({ project: "explicit" }));
    const other = join(home, "other");
    mkdirSync(other);
    writeFileSync(join(other, "langsmith-plugins.json"), JSON.stringify({ project: "env-dir" }));
    vi.spyOn(process, "cwd").mockReturnValue(join(home, "elsewhere"));
    expect(loadConfig().project).toBe("cursor");
    vi.stubEnv("CURSOR_PROJECT_DIR", other);
    expect(loadConfig().project).toBe("env-dir");
    expect(loadConfig({ cwd }).project).toBe("explicit");
  });

  it("prefers the LANGSMITH_CURSOR_ variable over the shorter LANGSMITH_ one", () => {
    vi.stubEnv("LANGSMITH_PROJECT", "short");
    vi.stubEnv("LANGSMITH_CURSOR_PROJECT", "cursor-only");
    expect(loadConfig({ cwd }).project).toBe("cursor-only");
  });

  it.each([
    ["LANGSMITH_CURSOR_API_KEY", "env-key", { apiKey: "env-key" }],
    ["LANGSMITH_CURSOR_ENDPOINT", "https://env.test", { apiUrl: "https://env.test" }],
    ["LANGSMITH_CURSOR_REDACT", "false", { redact: false }],
    ["LANGSMITH_CURSOR_ATTACHMENTS", "false", { attachmentsEnabled: false }],
    ["LANGSMITH_CURSOR_SYSTEM_PROMPT", "false", { systemPromptEnabled: false }],
    ["LANGSMITH_CURSOR_DB_PATH", "/env/db", { cursorDbPath: "/env/db" }],
    ["LANGSMITH_CURSOR_SWEEP_IDLE_MINUTES", "30", { sweepIdleMinutes: 30 }],
    ["LANGSMITH_CURSOR_DEBUG", "true", { debug: true }],
    ["LANGSMITH_CURSOR_STATE_FILE", "/env/state.json", { stateFilePath: "/env/state.json" }],
  ])("%s beats every file", (name, value, expected) => {
    FILES.forEach((_, index) =>
      write(index, {
        api_key: "file",
        api_url: "https://file.test",
        redact: true,
        attachments: true,
        system_prompt: true,
        cursor_db_path: "/file/db",
        sweep_idle_minutes: 90,
      }),
    );
    vi.stubEnv(name, value);
    expect(loadConfig({ cwd })).toMatchObject(expected);
  });

  it.each([
    ["TRACE_TO_LANGSMITH", "enabled"],
    ["LANGSMITH_CURSOR_DEFAULT_MUTED", "defaultMuted"],
  ] as const)("%s beats files that say the opposite", (name, field) => {
    for (const value of [true, false]) {
      FILES.forEach((_, index) => write(index, { enabled: !value, defaultMuted: !value }));
      vi.stubEnv(name, String(value));
      expect(loadConfig({ cwd })[field]).toBe(value);
    }
  });

  it.each(["true", "1", "yes", "on", " true ", " FALSE ", "0", "no", "off", "", "unknown"])(
    "reads the master switch loosely but the default mute strictly: %j",
    (value) => {
      write(3, { enabled: true, defaultMuted: false });
      vi.stubEnv("TRACE_TO_LANGSMITH", value);
      vi.stubEnv("LANGSMITH_CURSOR_DEFAULT_MUTED", value);
      expect(loadConfig({ cwd })).toMatchObject({
        enabled: ["true", "1", "yes", "on"].includes(value.trim().toLowerCase()),
        defaultMuted: value.toLowerCase() !== "false",
      });
    },
  );

  it.each([0, 1, 2, 3])(
    "an unreadable file at layer %s turns tracing off and mutes, unless the environment says otherwise",
    (index) => {
      write(index, "{broken");
      expect(loadConfig({ cwd })).toMatchObject({ enabled: false, defaultMuted: true });
      vi.stubEnv("TRACE_TO_LANGSMITH", "true");
      vi.stubEnv("LANGSMITH_CURSOR_DEFAULT_MUTED", "false");
      expect(loadConfig({ cwd })).toMatchObject({ enabled: true, defaultMuted: false });
    },
  );

  describe("the settings only Cursor has", () => {
    it.each([
      ["attachments", "attachmentsEnabled", false, true],
      ["system_prompt", "systemPromptEnabled", false, true],
      ["cursor_db_path", "cursorDbPath", "/lower", "/higher"],
      ["sweep_idle_minutes", "sweepIdleMinutes", 30, 5],
    ] as const)(
      "%s resolves layer by layer, and an empty layer falls through",
      (field, output, lower, higher) => {
        write(0, { [field]: lower });
        expect(loadConfig({ cwd })[output]).toEqual(lower);
        for (let index = 1; index < FILES.length; index++) {
          write(index, { [field]: higher });
          expect(loadConfig({ cwd })[output]).toEqual(higher);
          write(index, {});
          expect(loadConfig({ cwd })[output]).toEqual(lower);
        }
      },
    );

    it.each(["attachments", "system_prompt", "cursor_db_path"])(
      "an invalid %s falls through on its own, without disabling the rest or leaking its value",
      (field) => {
        write(1, { attachments: false, system_prompt: false, cursor_db_path: "user-db" });
        write(2, {
          enabled: true,
          api_key: "kept",
          [field]: { secret: "NEVER_LOG_EXTENSION" },
        });
        const spy = vi.spyOn(logger, "error").mockImplementation(() => {});
        expect(loadConfig({ cwd })).toMatchObject({
          enabled: true,
          apiKey: "kept",
          attachmentsEnabled: false,
          systemPromptEnabled: false,
          cursorDbPath: "user-db",
        });
        expect(spy).toHaveBeenCalledWith(
          `Invalid Cursor config extension ${field}; ignoring field.`,
        );
        expect(JSON.stringify(spy.mock.calls)).not.toContain("NEVER_LOG_EXTENSION");
      },
    );

    it.each([0, -5, "soon", null])("ignores an unusable sweep_idle_minutes: %j", (value) => {
      const spy = vi.spyOn(logger, "error").mockImplementation(() => {});
      write(0, { sweep_idle_minutes: value });
      expect(loadConfig({ cwd }).sweepIdleMinutes).toBe(360);
      expect(spy).toHaveBeenCalledWith(
        "Invalid Cursor config extension sweep_idle_minutes; ignoring field.",
      );
    });
  });

  describe("redaction rules from the environment", () => {
    it("skips invalid rules and keeps the valid ones", () => {
      vi.stubEnv(
        "LANGSMITH_CURSOR_REDACT_EXTRA",
        JSON.stringify([{ pattern: "sk-\\w+", replace: "X" }, { pattern: 42 }, { replace: "Y" }]),
      );
      expect(loadConfig({ cwd }).redactExtraRules).toEqual([{ pattern: "sk-\\w+", replace: "X" }]);
    });

    it.each(["LANGSMITH_CURSOR_REDACT_EXTRA", "LANGSMITH_REDACT_EXTRA"])(
      "%s: an empty array clears file rules but malformed values keep them",
      (env) => {
        const rules = [{ pattern: "file-secret", replace: "X" }];
        write(2, { redact_extra_rules: rules });
        expect(loadConfig({ cwd }).redactExtraRules).toEqual(rules);
        vi.stubEnv(env, "[]");
        expect(loadConfig({ cwd }).redactExtraRules).toEqual([]);
        for (const malformed of ["broken", "null", "{}", '[{"pattern":42}]']) {
          vi.stubEnv(env, malformed);
          expect(loadConfig({ cwd }).redactExtraRules).toEqual(rules);
        }
      },
    );
  });

  describe("replicas", () => {
    it("turns file replicas into SDK replicas, keeping empty values and empty lists", () => {
      write(2, {
        replicas: [{ api_url: "", api_key: "", project: "", updates: {} }],
      });
      expect(loadConfig({ cwd }).replicas).toEqual([
        { apiUrl: "", apiKey: "", projectName: "", updates: {} },
      ]);
      write(2, { replicas: [] });
      expect(loadConfig({ cwd }).replicas).toEqual([]);
    });

    it("lets the environment replace file replicas, turning SDK tuples into replica settings and accepting both name styles", () => {
      write(2, { replicas: [{ project: "file" }] });
      vi.stubEnv(
        "LANGSMITH_RUNS_ENDPOINTS",
        JSON.stringify([
          ["legacy-project", { tags: ["legacy"] }],
          { apiUrl: "https://sdk.test", projectName: "sdk" },
          { api_url: "https://snake.test", project: "snake" },
        ]),
      );
      expect(loadConfig({ cwd }).replicas).toEqual([
        { projectName: "legacy-project", updates: { tags: ["legacy"] } },
        { apiUrl: "https://sdk.test", projectName: "sdk" },
        { apiUrl: "https://snake.test", projectName: "snake" },
      ]);
      vi.stubEnv("LANGSMITH_CURSOR_RUNS_ENDPOINTS", "[]");
      expect(loadConfig({ cwd }).replicas).toEqual([]);
    });
  });

  describe("a managed file locking where traces go", () => {
    it("keeps environment replicas and the turn's project from bypassing the lock", () => {
      lock({ api_url: "https://locked.test", project: "locked" });
      vi.stubEnv(
        "LANGSMITH_CURSOR_RUNS_ENDPOINTS",
        JSON.stringify([{ api_url: "https://x.test" }]),
      );
      const writer = writerOptions(loadConfig({ cwd }), "turn-project");
      expect(writer.destinations).toEqual([
        expect.objectContaining({ apiUrl: "https://locked.test", projectName: "locked" }),
      ]);
      expect(writer.replicas ?? []).toEqual([]);
      expect(writer.projectLocked).toBe(true);
    });

    it("locks the privacy switches and warns about the operational settings it can't lock", () => {
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      lock({}, { attachments: false, system_prompt: false, sweep_idle_minutes: 5 });
      vi.stubEnv("LANGSMITH_CURSOR_ATTACHMENTS", "true");
      vi.stubEnv("LANGSMITH_CURSOR_SYSTEM_PROMPT", "true");
      expect(loadConfig({ cwd })).toMatchObject({
        attachmentsEnabled: false,
        systemPromptEnabled: false,
        sweepIdleMinutes: 360,
      });
      expect(warned).toHaveBeenCalledWith(expect.stringContaining("sweep_idle_minutes"));
    });

    it("keeps environment redaction rules from bypassing the lock", () => {
      lock({ redact_extra_rules: [{ pattern: "x" }] });
      vi.stubEnv("LANGSMITH_CURSOR_REDACT_EXTRA", "[]");
      expect(loadConfig({ cwd }).redactExtraRules).toEqual([{ pattern: "x" }]);
    });
  });

  describe("uploading with the LangSmith CLI login", () => {
    function writeLogin(apiUrl: string) {
      mkdirSync(join(home, ".langsmith"));
      writeFileSync(
        join(home, ".langsmith", "config.json"),
        JSON.stringify({
          profiles: { default: { api_url: apiUrl, oauth: { refresh_token: "t" } } },
        }),
      );
    }

    it("uses the login and its server when no API key is set", () => {
      writeLogin("https://login.test");
      expect(writerOptions(loadConfig({ cwd }), "p").destinations[0]).toEqual({
        login: expect.objectContaining({ profile: "default" }),
        apiUrl: "https://login.test",
        projectName: "p",
      });
    });

    it("lets the login beat a generic LANGSMITH_API_KEY", () => {
      writeLogin("https://login.test");
      vi.stubEnv("LANGSMITH_API_KEY", "generic-key");
      expect(uploadCredential(loadConfig({ cwd })).kind).toBe("login");
    });

    it("still uploads with a generic LANGSMITH_API_KEY when there's no login", () => {
      vi.stubEnv("LANGSMITH_API_KEY", "generic-key");
      expect(uploadCredential(loadConfig({ cwd }))).toMatchObject({ apiKey: "generic-key" });
    });

    it.each(['""', "   ", '" "'])(
      "treats the key %s as missing so the login never goes to a server the repo chose",
      (key) => {
        writeLogin("https://login.test");
        vi.stubEnv("LANGSMITH_CURSOR_API_KEY", key);
        vi.stubEnv("LANGSMITH_CURSOR_ENDPOINT", "https://repo.test");
        expect(uploadCredential(loadConfig({ cwd })).kind).toBe("none");
      },
    );

    it("never sends the login to a server the lock names instead", () => {
      writeLogin("https://login.test");
      lock({ api_url: "https://locked.test" });
      expect(writerOptions(loadConfig({ cwd }), "p").destinations[0]).not.toHaveProperty("login");
    });

    it("reads strict auth from the environment unless the lock sets it", () => {
      vi.stubEnv("LANGSMITH_CURSOR_STRICT_AUTH", "true");
      expect(loadConfig({ cwd }).strictAuth).toBe(true);
      lock({ strict_auth: false });
      expect(loadConfig({ cwd }).strictAuth).toBe(false);
    });
  });

  describe("run metadata", () => {
    it("attaches the user name and the working directory", () => {
      const config = loadConfig({ cwd });
      expect(config.customMetadata?.local_username).toBeTruthy();
      expect(config.customMetadata?.cwd).toBe(cwd);
    });

    it("leaves the workspace repository and commit for the uploader to find", () => {
      const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
      git("init", "-q", "-b", "trunk");
      git("remote", "add", "origin", "git@github.com:acme/widget.git");
      git("commit", "-q", "--allow-empty", "-m", "c");
      const keys = Object.keys(loadConfig({ cwd }).customMetadata ?? {});
      expect(keys.filter((key) => key.startsWith("git_") || key.startsWith("repository_"))).toEqual(
        [],
      );
    });

    it("lets metadata from files and the environment replace the defaults per key", () => {
      write(1, { metadata: { cwd: "from-file", file: true } });
      vi.stubEnv("LANGSMITH_CURSOR_METADATA", JSON.stringify({ local_username: "from-env" }));
      expect(loadConfig({ cwd }).customMetadata).toMatchObject({
        cwd: "from-file",
        file: true,
        local_username: "from-env",
      });
    });
  });
});
