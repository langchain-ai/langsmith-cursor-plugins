import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseRepoName } from "../src/config.js";
import * as logger from "../src/logger.js";

function writeCursorConfig(dir: string, cfg: Record<string, unknown>): void {
  mkdirSync(join(dir, ".cursor"), { recursive: true });
  writeFileSync(join(dir, ".cursor", "langsmith.json"), JSON.stringify(cfg));
}

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
    "LANGSMITH_CURSOR_SWEEP",
    "LANGSMITH_CURSOR_SWEEP_IDLE_MINUTES",
  ]) {
    vi.stubEnv(k, undefined as unknown as string);
  }
}

describe("loadConfig cascade", () => {
  it("local .cursor/langsmith.json overrides global; env overrides both", () => {
    clearEnv();
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const proj = mkdtempSync(join(tmpdir(), "proj-"));
    vi.stubEnv("HOME", home);

    writeCursorConfig(home, { enabled: true, api_key: "global-key", project: "global-proj" });
    writeCursorConfig(proj, { project: "local-proj" });

    const cfg = loadConfig({ cwd: proj });
    expect(cfg.enabled).toBe(true); // absent project enabled inherits from global
    expect(cfg.apiKey).toBe("global-key"); // inherited from global
    expect(cfg.project).toBe("local-proj"); // local wins

    // env overrides the file project
    vi.stubEnv("LANGSMITH_PROJECT", "env-proj");
    expect(loadConfig({ cwd: proj }).project).toBe("env-proj");
  });

  it("defaults to disabled with no config", () => {
    clearEnv();
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const proj = mkdtempSync(join(tmpdir(), "proj-"));
    vi.stubEnv("HOME", home);
    const cfg = loadConfig({ cwd: proj });
    expect(cfg.enabled).toBe(false);
    expect(cfg.project).toBe("cursor");
    expect(cfg.apiUrl).toBe("https://api.smith.langchain.com");
  });

  it("TRACE_TO_LANGSMITH=true enables tracing via env", () => {
    clearEnv();
    const home = mkdtempSync(join(tmpdir(), "home-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("TRACE_TO_LANGSMITH", "true");
    vi.stubEnv("LANGSMITH_CURSOR_API_KEY", "k");
    const cfg = loadConfig({ cwd: home });
    expect(cfg.enabled).toBe(true);
    expect(cfg.apiKey).toBe("k");
  });

  it("redaction defaults on; LANGSMITH_CURSOR_REDACT=false disables it", () => {
    clearEnv();
    const home = mkdtempSync(join(tmpdir(), "home-"));
    vi.stubEnv("HOME", home);
    expect(loadConfig({ cwd: home }).redact).toBe(true);
    vi.stubEnv("LANGSMITH_CURSOR_REDACT", "false");
    expect(loadConfig({ cwd: home }).redact).toBe(false);
  });

  it("parses LANGSMITH_CURSOR_REDACT_EXTRA; skips invalid rules", () => {
    clearEnv();
    const home = mkdtempSync(join(tmpdir(), "home-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv(
      "LANGSMITH_CURSOR_REDACT_EXTRA",
      JSON.stringify([{ pattern: "sk-\\w+", replace: "X" }, { pattern: 42 }, { replace: "Y" }]),
    );
    expect(loadConfig({ cwd: home }).redactExtraRules).toEqual([
      { pattern: "sk-\\w+", replace: "X" },
    ]);
  });

  it("attaches local_username identity metadata", () => {
    clearEnv();
    const home = mkdtempSync(join(tmpdir(), "home-"));
    vi.stubEnv("HOME", home);
    const cfg = loadConfig({ cwd: home });
    expect(cfg.customMetadata?.local_username).toBeTruthy();
  });
});

describe("parseRepoName", () => {
  it("extracts owner/repo from common remotes", () => {
    expect(parseRepoName("git@github.com:langchain-ai/langsmith-cursor-plugins.git ")).toEqual({
      provider: "github",
      name: "langchain-ai/langsmith-cursor-plugins",
    });
    expect(parseRepoName("https://gitlab.com/acme/widget.git ")).toEqual({
      provider: "gitlab",
      name: "acme/widget",
    });
  });
});

describe("master environment-first privacy gate", () => {
  it.each([
    [false, true, "true", true],
    [true, false, "false", false],
    [undefined, true, "false", false],
    [undefined, false, "true", true],
    [undefined, undefined, "true", true],
    [undefined, undefined, undefined, false],
  ])("project=%s user=%s env=%s => %s", (local, global, env, expected) => {
    clearEnv();
    const home = mkdtempSync(join(tmpdir(), "cursor-master-home-"));
    const proj = mkdtempSync(join(tmpdir(), "cursor-master-proj-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("TRACE_TO_LANGSMITH", env);
    if (local !== undefined) writeCursorConfig(proj, { enabled: local });
    if (global !== undefined) writeCursorConfig(home, { enabled: global });
    expect(loadConfig({ cwd: proj }).enabled).toBe(expected);
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  });

  it.each(["broken", "null", "[]", '{"enabled":"true"}', "directory", "dangling"])(
    "fails closed on present %s project config",
    (raw) => {
      clearEnv();
      const home = mkdtempSync(join(tmpdir(), "cursor-master-home-"));
      const proj = mkdtempSync(join(tmpdir(), "cursor-master-proj-"));
      vi.stubEnv("HOME", home);
      vi.stubEnv("TRACE_TO_LANGSMITH", undefined);
      writeCursorConfig(home, { enabled: true });
      mkdirSync(join(proj, ".cursor"));
      const file = join(proj, ".cursor", "langsmith.json");
      if (raw === "directory") mkdirSync(file);
      else if (raw === "dangling") symlinkSync(join(home, "absent"), file);
      else writeFileSync(file, raw);
      expect(loadConfig({ cwd: proj }).enabled).toBe(false);
      rmSync(home, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    },
  );
});

describe("table-driven default mute configuration", () => {
  function setup() {
    clearEnv();
    const home = mkdtempSync(join(tmpdir(), "cursor-default-home-"));
    const proj = mkdtempSync(join(tmpdir(), "cursor-default-proj-"));
    vi.stubEnv("HOME", home);
    return { home, proj };
  }

  it.each([
    [true, false, "false", false],
    [false, true, "true", true],
    [undefined, true, "false", false],
    [undefined, false, "true", true],
    [undefined, undefined, "TrUe", true],
    [undefined, undefined, "FaLsE", false],
    [undefined, undefined, undefined, false],
    [undefined, undefined, "", true],
    [undefined, undefined, " false ", true],
    [undefined, undefined, "0", true],
    [undefined, undefined, "unknown", true],
  ])("project=%s user=%s env=%s => mute=%s", (local, global, env, expected) => {
    const { home, proj } = setup();
    try {
      vi.stubEnv("LANGSMITH_CURSOR_DEFAULT_MUTED", env);
      if (local !== undefined) writeCursorConfig(proj, { defaultMuted: local });
      if (global !== undefined) writeCursorConfig(home, { defaultMuted: global });
      expect(loadConfig({ cwd: proj }).defaultMuted).toBe(expected);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it("resolves missing fields independently, including empty files and env master", () => {
    const { home, proj } = setup();
    try {
      vi.stubEnv("TRACE_TO_LANGSMITH", "TrUe");
      vi.stubEnv("LANGSMITH_CURSOR_DEFAULT_MUTED", "true");
      writeCursorConfig(proj, { defaultMuted: false });
      expect(loadConfig({ cwd: proj })).toMatchObject({ enabled: true, defaultMuted: true });
      writeCursorConfig(home, { defaultMuted: true });
      writeCursorConfig(proj, { enabled: false });
      expect(loadConfig({ cwd: proj })).toMatchObject({ enabled: true, defaultMuted: true });
      writeCursorConfig(proj, {});
      expect(loadConfig({ cwd: proj })).toMatchObject({ enabled: true, defaultMuted: true });
      writeCursorConfig(home, {});
      expect(loadConfig({ cwd: proj })).toMatchObject({ enabled: true, defaultMuted: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it.each([null, "false", 0, [], {}].map((value) => [value]))(
    "invalid present booleans fail closed: %j",
    (value) => {
      const { home, proj } = setup();
      try {
        writeCursorConfig(home, { enabled: true, defaultMuted: false });
        writeCursorConfig(proj, { enabled: value, defaultMuted: value });
        expect(loadConfig({ cwd: proj })).toMatchObject({ enabled: false, defaultMuted: true });
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
      }
    },
  );

  it.each(["broken", "null", "[]", "directory", "dangling"])(
    "unhealthy files restrict both fields: %s",
    (raw) => {
      const { home, proj } = setup();
      try {
        vi.stubEnv("TRACE_TO_LANGSMITH", undefined);
        vi.stubEnv("LANGSMITH_CURSOR_DEFAULT_MUTED", undefined);
        writeCursorConfig(home, { enabled: true, defaultMuted: false });
        mkdirSync(join(proj, ".cursor"));
        const file = join(proj, ".cursor", "langsmith.json");
        if (raw === "directory") mkdirSync(file);
        else if (raw === "dangling") symlinkSync(join(home, "absent"), file);
        else writeFileSync(file, raw);
        expect(loadConfig({ cwd: proj })).toMatchObject({ enabled: false, defaultMuted: true });
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
      }
    },
  );

  it.each([
    [" true ", true],
    ["1", true],
    ["yes", true],
    ["on", true],
    [" TrUe\t", true],
    [" YES ", true],
    [" ON ", true],
    [" 1 ", true],
    ["", false],
    ["false", false],
    ["0", false],
    ["no", false],
    ["off", false],
    [" FaLsE ", false],
    [" NO ", false],
    [" OFF ", false],
    [" 0 ", false],
    ["invalid", false],
  ] as const)("historical master env %j => %s", (env, expected) => {
    const { home, proj } = setup();
    try {
      vi.stubEnv("TRACE_TO_LANGSMITH", env);
      expect(loadConfig({ cwd: proj }).enabled).toBe(expected);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });
});

it.skipIf(process.getuid?.() === 0)("unreadable regular config restricts both settings", () => {
  clearEnv();
  const home = mkdtempSync(join(tmpdir(), "cursor-unreadable-"));
  const file = join(home, ".cursor", "langsmith.json");
  vi.stubEnv("HOME", home);
  vi.stubEnv("TRACE_TO_LANGSMITH", undefined);
  vi.stubEnv("LANGSMITH_CURSOR_DEFAULT_MUTED", undefined);
  writeCursorConfig(home, { enabled: true, defaultMuted: false });
  try {
    chmodSync(file, 0o000);
    expect(loadConfig({ cwd: home })).toMatchObject({ enabled: false, defaultMuted: true });
  } finally {
    chmodSync(file, 0o600);
    rmSync(home, { recursive: true, force: true });
  }
});

describe("root project langsmith-plugins.json", () => {
  let home: string;
  let proj: string;

  beforeEach(() => {
    clearEnv();
    for (const key of Object.keys(process.env)) {
      if (/^(LANGSMITH_|LANGCHAIN_|CURSOR_PROJECT_DIR)/.test(key)) vi.stubEnv(key, undefined);
    }
    home = mkdtempSync(join(tmpdir(), "cursor-root-home-"));
    proj = join(home, "workspace");
    mkdirSync(proj);
    vi.stubEnv("HOME", home);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  function writeRoot(cfg: Record<string, unknown>) {
    writeFileSync(join(proj, "langsmith-plugins.json"), JSON.stringify(cfg));
  }

  it.each([
    JSON.stringify({ enabled: false, defaultMuted: true, project: "old-app" }),
    JSON.stringify({ enabled: true, defaultMuted: false, project: "old-app" }),
    "{malformed",
  ])("ignores old root langsmith.json entirely: %s", (raw) => {
    const diagnostics = vi.spyOn(logger, "error").mockImplementation(() => {});
    writeFileSync(join(proj, "langsmith.json"), raw);
    // No alias: even an enabling old file cannot supply settings on its own.
    expect(loadConfig({ cwd: proj })).toMatchObject({ enabled: false, defaultMuted: false });
    expect(loadConfig({ cwd: proj }).project).not.toBe("old-app");
    writeCursorConfig(home, { enabled: true, defaultMuted: false, project: "user" });
    expect(loadConfig({ cwd: proj })).toMatchObject({
      enabled: true,
      defaultMuted: false,
      project: "user",
    });
    writeRoot({ enabled: true, defaultMuted: true, project: "new-root" });
    expect(loadConfig({ cwd: proj })).toMatchObject({
      enabled: true,
      defaultMuted: true,
      project: "new-root",
    });
    writeCursorConfig(proj, { enabled: false, defaultMuted: false, project: "harness" });
    expect(loadConfig({ cwd: proj })).toMatchObject({
      enabled: false,
      defaultMuted: false,
      project: "harness",
    });
    expect(diagnostics).not.toHaveBeenCalled();
  });

  describe.each([
    { field: "enabled", env: "TRACE_TO_LANGSMITH", restrictive: false },
    { field: "defaultMuted", env: "LANGSMITH_CURSOR_DEFAULT_MUTED", restrictive: true },
  ] as const)("$field precedence", ({ field, env, restrictive }) => {
    it.each([
      [true, false, false, "false", false],
      [false, true, true, "true", true],
      [undefined, true, false, "false", false],
      [undefined, false, true, "true", true],
      [undefined, undefined, true, "false", false],
      [undefined, undefined, false, "true", true],
      [undefined, undefined, undefined, "TrUe", true],
      [undefined, undefined, undefined, "FaLsE", false],
      [undefined, undefined, undefined, undefined, false],
    ])("harness=%s root=%s user=%s env=%s => %s", (local, root, global, value, expected) => {
      writeCursorConfig(proj, local === undefined ? {} : { [field]: local });
      writeRoot(root === undefined ? {} : { [field]: root });
      writeCursorConfig(home, global === undefined ? {} : { [field]: global });
      vi.stubEnv(env, value);
      expect(loadConfig({ cwd: proj })[field]).toBe(expected);
    });

    it.each([null, "false", "true", 0, [], {}].map((value) => [value]))(
      "invalid root field %j restricts only that field",
      (value) => {
        writeCursorConfig(home, { enabled: true, defaultMuted: false });
        writeRoot({ [field]: value });
        expect(loadConfig({ cwd: proj })).toMatchObject({
          enabled: true,
          defaultMuted: false,
          [field]: restrictive,
        });
        writeCursorConfig(proj, { [field]: !restrictive });
        expect(loadConfig({ cwd: proj })[field]).toBe(!restrictive);
      },
    );
  });

  it("resolves each field independently across harness, root, user and env", () => {
    vi.stubEnv("TRACE_TO_LANGSMITH", undefined);
    vi.stubEnv("LANGSMITH_CURSOR_DEFAULT_MUTED", undefined);
    writeCursorConfig(home, { defaultMuted: true });
    writeRoot({ enabled: false });
    expect(loadConfig({ cwd: proj })).toMatchObject({ enabled: false, defaultMuted: true });
    writeCursorConfig(proj, { enabled: true });
    expect(loadConfig({ cwd: proj })).toMatchObject({ enabled: true, defaultMuted: true });
    writeRoot({ defaultMuted: false });
    expect(loadConfig({ cwd: proj })).toMatchObject({ enabled: true, defaultMuted: false });
    writeCursorConfig(proj, {});
    writeCursorConfig(home, {});
    writeRoot({ defaultMuted: true });
    expect(loadConfig({ cwd: proj })).toMatchObject({ enabled: false, defaultMuted: true });
  });

  it.each(["broken", "null", "[]", "directory", "dangling", "empty"])(
    "unhealthy root %s restricts both fields, but not explicit higher fields",
    (raw) => {
      vi.stubEnv("TRACE_TO_LANGSMITH", undefined);
      vi.stubEnv("LANGSMITH_CURSOR_DEFAULT_MUTED", undefined);
      writeCursorConfig(home, { enabled: true, defaultMuted: false });
      const file = join(proj, "langsmith-plugins.json");
      if (raw === "directory") mkdirSync(file);
      else if (raw === "dangling") symlinkSync(join(home, "absent"), file);
      else writeFileSync(file, raw === "empty" ? "" : raw);
      expect(loadConfig({ cwd: proj })).toMatchObject({ enabled: false, defaultMuted: true });
      writeCursorConfig(proj, { enabled: true });
      expect(loadConfig({ cwd: proj })).toMatchObject({ enabled: true, defaultMuted: true });
      writeCursorConfig(proj, { defaultMuted: false });
      expect(loadConfig({ cwd: proj })).toMatchObject({ enabled: false, defaultMuted: false });
      writeCursorConfig(proj, { enabled: true, defaultMuted: false });
      expect(loadConfig({ cwd: proj })).toMatchObject({ enabled: true, defaultMuted: false });
    },
  );

  it.skipIf(process.getuid?.() === 0)("unreadable root fails closed", () => {
    writeCursorConfig(home, { enabled: true, defaultMuted: false });
    writeRoot({ enabled: true, defaultMuted: false });
    const file = join(proj, "langsmith-plugins.json");
    try {
      chmodSync(file, 0o000);
      expect(loadConfig({ cwd: proj })).toMatchObject({ enabled: false, defaultMuted: true });
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it("missing root and missing cwd fall through without ancestor discovery", () => {
    writeCursorConfig(home, { enabled: true, defaultMuted: false });
    writeFileSync(
      join(home, "langsmith-plugins.json"),
      JSON.stringify({ enabled: false, defaultMuted: true }),
    );
    expect(loadConfig({ cwd: proj })).toMatchObject({ enabled: true, defaultMuted: false });
    expect(loadConfig({ cwd: join(proj, "missing") })).toMatchObject({
      enabled: true,
      defaultMuted: false,
    });
  });

  it("uses explicit cwd before CURSOR_PROJECT_DIR before process.cwd", () => {
    writeRoot({ enabled: true, defaultMuted: true });
    vi.spyOn(process, "cwd").mockReturnValue(proj);
    expect(loadConfig()).toMatchObject({ enabled: true, defaultMuted: true });
    const other = join(home, "other");
    mkdirSync(other);
    writeFileSync(
      join(other, "langsmith-plugins.json"),
      JSON.stringify({ enabled: false, defaultMuted: false }),
    );
    vi.stubEnv("CURSOR_PROJECT_DIR", other);
    expect(loadConfig()).toMatchObject({ enabled: false, defaultMuted: false });
    expect(loadConfig({ cwd: proj })).toMatchObject({ enabled: true, defaultMuted: true });
  });

  it("overlays every supported non-privacy file setting below harness and env", () => {
    function settings(label: string, flag: boolean) {
      return {
        api_key: label,
        api_url: `https://${label}.test`,
        project: label,
        replicas: [{ api_key: label, api_url: `https://${label}.test`, project: label }],
        attachments: flag,
        system_prompt: flag,
        cursor_db_path: label,
        redact: flag,
        metadata: { shared: label, [label]: true },
      };
    }
    function expected(label: string, flag: boolean) {
      return {
        apiKey: label,
        apiUrl: `https://${label}.test`,
        project: label,
        replicas: [{ apiKey: label, apiUrl: `https://${label}.test`, projectName: label }],
        attachmentsEnabled: flag,
        systemPromptEnabled: flag,
        cursorDbPath: label,
        redact: flag,
      };
    }
    writeCursorConfig(home, settings("user", true));
    writeRoot(settings("root", false));
    expect(loadConfig({ cwd: proj })).toMatchObject(expected("root", false));
    writeCursorConfig(proj, settings("harness", true));
    expect(loadConfig({ cwd: proj })).toMatchObject(expected("harness", true));
    const values = {
      API_KEY: "env",
      ENDPOINT: "https://env.test",
      PROJECT: "env",
      RUNS_ENDPOINTS: JSON.stringify(settings("env", false).replicas),
      ATTACHMENTS: "false",
      SYSTEM_PROMPT: "false",
      DB_PATH: "env",
      REDACT: "false",
      METADATA: JSON.stringify(settings("env", false).metadata),
    };
    for (const [key, value] of Object.entries(values)) vi.stubEnv(`LANGSMITH_CURSOR_${key}`, value);
    expect(loadConfig({ cwd: proj })).toMatchObject({
      ...expected("env", false),
      customMetadata: { shared: "env", user: true, root: true, harness: true, env: true },
    });
    // Invalid ordinary common fields discard the entire file, including its metadata.
    for (const key of Object.keys(values)) vi.stubEnv(`LANGSMITH_CURSOR_${key}`, undefined);
    writeCursorConfig(proj, { api_key: null, metadata: { shared: "harness" } });
    expect(loadConfig({ cwd: proj })).toMatchObject({
      ...expected("root", false),
      enabled: false,
      defaultMuted: true,
      customMetadata: { shared: "root", user: true, root: true },
    });
    writeRoot({});
    expect(loadConfig({ cwd: proj })).toMatchObject(expected("user", true));
  });

  it.each(["LANGSMITH_CURSOR_REDACT_EXTRA", "LANGSMITH_REDACT_EXTRA"])(
    "%s empty array clears file rules; malformed values retain fallback",
    (env) => {
      const rules = [{ pattern: "file-secret", replace: "X" }];
      writeRoot({ redact_extra_rules: rules });
      expect(loadConfig({ cwd: proj }).redactExtraRules).toEqual(rules);
      vi.stubEnv(env, "[]");
      expect(loadConfig({ cwd: proj }).redactExtraRules).toEqual([]);
      for (const malformed of ["broken", "null", "{}", '[{"pattern":42}]']) {
        vi.stubEnv(env, malformed);
        expect(loadConfig({ cwd: proj }).redactExtraRules).toEqual(rules);
      }
    },
  );

  it.each(["root", "harness", "user"])("accepts readable %s config symlinks", (scope) => {
    const target = join(home, "target.json");
    writeFileSync(
      target,
      JSON.stringify({ enabled: true, defaultMuted: false, project: "linked" }),
    );
    const file =
      scope === "root"
        ? join(proj, "langsmith-plugins.json")
        : join(scope === "user" ? home : proj, ".cursor", "langsmith.json");
    mkdirSync(join(file, ".."), { recursive: true });
    symlinkSync(target, file);
    expect(loadConfig({ cwd: proj })).toMatchObject({
      enabled: true,
      defaultMuted: false,
      project: "linked",
    });
  });

  it.each(["attachments", "system_prompt", "cursor_db_path"])(
    "invalid %s extension falls through independently without disabling common",
    (field) => {
      writeCursorConfig(home, {
        attachments: false,
        system_prompt: false,
        cursor_db_path: "user-db",
      });
      writeRoot({
        enabled: true,
        defaultMuted: false,
        api_key: "kept",
        [field]: { secret: "NEVER_LOG_EXTENSION" },
        claude: null,
        step_fidelity: [],
      });
      const spy = vi.spyOn(logger, "error").mockImplementation(() => {});
      expect(loadConfig({ cwd: proj })).toMatchObject({
        enabled: true,
        defaultMuted: false,
        apiKey: "kept",
        attachmentsEnabled: false,
        systemPromptEnabled: false,
        cursorDbPath: "user-db",
      });
      expect(spy).toHaveBeenCalledWith(`Invalid Cursor config extension ${field}; ignoring field.`);
      expect(JSON.stringify(spy.mock.calls)).not.toContain("NEVER_LOG_EXTENSION");
    },
  );

  it("normalizes file replicas with canonical presence, empty arrays and rules", () => {
    writeCursorConfig(home, {
      replicas: [{ project: "user" }],
      redact_extra_rules: [{ pattern: "user" }],
    });
    writeRoot({
      replicas: [
        {
          api_url: "",
          apiUrl: "ignored",
          api_key: "",
          apiKey: "ignored",
          project: "",
          projectName: "ignored",
          updates: {},
        },
      ],
      redact_extra_rules: [{ pattern: "private-[0-9]+", replace: "X" }],
    });
    expect(loadConfig({ cwd: proj })).toMatchObject({
      replicas: [{ apiUrl: "", apiKey: "", projectName: "", updates: {} }],
      redactExtraRules: [{ pattern: "private-[0-9]+", replace: "X" }],
    });
    writeRoot({ replicas: [], redact_extra_rules: [] });
    expect(loadConfig({ cwd: proj })).toMatchObject({ replicas: [], redactExtraRules: [] });
    vi.stubEnv(
      "LANGSMITH_RUNS_ENDPOINTS",
      JSON.stringify([
        ["legacy-project", { tags: ["legacy"] }],
        { apiUrl: "https://sdk.test", projectName: "sdk" },
      ]),
    );
    expect(loadConfig({ cwd: proj }).replicas).toEqual([
      ["legacy-project", { tags: ["legacy"] }],
      { apiUrl: "https://sdk.test", projectName: "sdk" },
    ]);
    vi.stubEnv("LANGSMITH_CURSOR_RUNS_ENDPOINTS", "[]");
    expect(loadConfig({ cwd: proj }).replicas).toEqual([]);
  });

  it.each([
    { project: null },
    { replicas: [{ api_key: null, apiKey: "alias" }] },
    { redact_extra_rules: [{ pattern: "[" }] },
    { metadata: [] },
    { redact: "false" },
  ])("invalid ordinary root common restricts switches and discards ordinary fields: %j", (bad) => {
    writeCursorConfig(home, {
      enabled: true,
      defaultMuted: false,
      project: "user",
      metadata: { kept: true },
    });
    writeRoot({
      enabled: true,
      defaultMuted: false,
      api_key: "discard",
      metadata: { discard: true },
      attachments: false,
      ...bad,
    });
    expect(loadConfig({ cwd: proj })).toMatchObject({
      enabled: false,
      defaultMuted: true,
      apiKey: "",
      project: "user",
      attachmentsEnabled: false,
    });
    expect(loadConfig({ cwd: proj }).customMetadata).not.toHaveProperty("discard");
    writeCursorConfig(proj, { enabled: true, defaultMuted: false });
    expect(loadConfig({ cwd: proj })).toMatchObject({ enabled: true, defaultMuted: false });
  });
});

describe("uniform environment-first and home-root precedence", () => {
  let home: string;
  let cwd: string;
  let files: string[];
  beforeEach(() => {
    clearEnv();
    home = mkdtempSync(join(tmpdir(), "cursor-home-cascade-"));
    cwd = join(home, "workspace");
    mkdirSync(join(cwd, ".cursor"), { recursive: true });
    mkdirSync(join(home, ".cursor"));
    vi.stubEnv("HOME", home);
    files = [
      join(home, ".langsmith-plugins.json"),
      join(home, ".cursor", "langsmith.json"),
      join(cwd, "langsmith-plugins.json"),
      join(cwd, ".cursor", "langsmith.json"),
    ];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });
  function write(index: number, value: Record<string, unknown>) {
    writeFileSync(files[index], JSON.stringify(value));
  }

  it.each([
    JSON.stringify({ enabled: true, defaultMuted: true, project: "old-home", api_key: "old-key" }),
    JSON.stringify({ enabled: false, defaultMuted: true, project: "old-home" }),
    "{malformed",
    "directory",
    "dangling",
  ])("ignores retired home filename without fallback: %s", (raw) => {
    const diagnostics = vi.spyOn(logger, "error").mockImplementation(() => {});
    const oldHome = join(home, "langsmith-plugins.json");
    if (raw === "directory") mkdirSync(oldHome);
    else if (raw === "dangling") symlinkSync(join(home, "absent"), oldHome);
    else writeFileSync(oldHome, raw);
    expect(loadConfig({ cwd })).toMatchObject({
      enabled: false,
      defaultMuted: false,
      project: "cursor",
      apiKey: "",
    });
    write(0, { enabled: true, defaultMuted: false, project: "hidden-home", api_key: "new-key" });
    expect(loadConfig({ cwd })).toMatchObject({
      enabled: true,
      defaultMuted: false,
      project: "hidden-home",
      apiKey: "new-key",
    });
    rmSync(files[0]);
    expect(loadConfig({ cwd })).toMatchObject({
      enabled: false,
      defaultMuted: false,
      project: "cursor",
      apiKey: "",
    });
    expect(diagnostics).not.toHaveBeenCalled();
  });

  it("keeps the visible project lookup when cwd equals home", () => {
    write(0, { enabled: false, defaultMuted: true, project: "hidden-home", api_key: "home-key" });
    writeFileSync(
      join(home, "langsmith-plugins.json"),
      JSON.stringify({ enabled: true, defaultMuted: false, project: "visible-project" }),
    );
    expect(loadConfig({ cwd: home })).toMatchObject({
      enabled: true,
      defaultMuted: false,
      project: "visible-project",
      apiKey: "home-key",
    });
    write(1, { project: "cursor-project" });
    expect(loadConfig({ cwd: home }).project).toBe("cursor-project");
    vi.stubEnv("LANGSMITH_CURSOR_PROJECT", "env");
    expect(loadConfig({ cwd: home }).project).toBe("env");
  });

  it.each([
    ["enabled", "enabled", "TRACE_TO_LANGSMITH", true, false],
    ["defaultMuted", "defaultMuted", "LANGSMITH_CURSOR_DEFAULT_MUTED", true, false],
    ["api_key", "apiKey", "LANGSMITH_CURSOR_API_KEY", "lower", ""],
    ["api_url", "apiUrl", "LANGSMITH_CURSOR_ENDPOINT", "https://lower.test", ""],
    ["project", "project", "LANGSMITH_CURSOR_PROJECT", "lower", ""],
    ["replicas", "replicas", "LANGSMITH_CURSOR_RUNS_ENDPOINTS", [{}], []],
    ["redact", "redact", "LANGSMITH_CURSOR_REDACT", true, false],
    [
      "redact_extra_rules",
      "redactExtraRules",
      "LANGSMITH_CURSOR_REDACT_EXTRA",
      [{ pattern: "lower" }],
      [],
    ],
    ["attachments", "attachmentsEnabled", "LANGSMITH_CURSOR_ATTACHMENTS", true, false],
    ["system_prompt", "systemPromptEnabled", "LANGSMITH_CURSOR_SYSTEM_PROMPT", true, false],
    ["cursor_db_path", "cursorDbPath", "LANGSMITH_CURSOR_DB_PATH", "lower", ""],
    ["sweep", "sweepEnabled", "LANGSMITH_CURSOR_SWEEP", true, false],
    ["sweep_idle_minutes", "sweepIdleMinutes", "LANGSMITH_CURSOR_SWEEP_IDLE_MINUTES", 30, 5],
  ] as const)(
    "%s resolves every source independently, preserving empty/false overrides",
    (field, output, env, lower, higher) => {
      write(0, { [field]: lower });
      expect(loadConfig({ cwd })[output]).toEqual(lower);
      // Every file layer must win over all lower layers, then fall back when its field is absent.
      for (let index = 1; index < files.length; index++) {
        for (let i = 0; i < index; i++) write(i, { [field]: lower });
        write(index, { [field]: higher });
        expect(loadConfig({ cwd })[output]).toEqual(higher);
        write(index, {});
        expect(loadConfig({ cwd })[output]).toEqual(lower);
      }
      write(3, { [field]: lower });
      vi.stubEnv(env, typeof higher === "string" ? higher : JSON.stringify(higher));
      expect(loadConfig({ cwd })[output]).toEqual(higher);
      vi.stubEnv(env, undefined);
      expect(loadConfig({ cwd })[output]).toEqual(lower);
    },
  );

  it("recovers stranded turns after half a day unless it is switched off", () => {
    expect(loadConfig({ cwd })).toMatchObject({ sweepEnabled: true, sweepIdleMinutes: 360 });
    write(0, { sweep: false });
    expect(loadConfig({ cwd }).sweepEnabled).toBe(false);
    vi.stubEnv("LANGSMITH_CURSOR_SWEEP", "on");
    expect(loadConfig({ cwd }).sweepEnabled).toBe(true);
  });

  it.each([0, -5, "soon", null])("ignores an unusable sweep_idle_minutes: %j", (value) => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => {});
    write(0, { sweep_idle_minutes: value });
    expect(loadConfig({ cwd }).sweepIdleMinutes).toBe(360);
    expect(spy).toHaveBeenCalledWith(
      "Invalid Cursor config extension sweep_idle_minutes; ignoring field.",
    );
    spy.mockRestore();
  });

  it("merges metadata low-to-high per key, replacing nested values and retaining home keys", () => {
    for (let i = 0; i < files.length; i++) {
      write(i, { metadata: { [i]: true, winner: i, nested: { [i]: true } } });
      expect(loadConfig({ cwd }).customMetadata).toMatchObject({
        winner: i,
        nested: { [i]: true },
      });
      expect(loadConfig({ cwd }).customMetadata?.nested).toEqual({ [i]: true });
    }
    vi.stubEnv("LANGSMITH_CURSOR_METADATA", JSON.stringify({ winner: "env", nested: ["env"] }));
    expect(loadConfig({ cwd }).customMetadata).toMatchObject({
      0: true,
      1: true,
      2: true,
      3: true,
      winner: "env",
      nested: ["env"],
    });
    vi.stubEnv("LANGSMITH_CURSOR_METADATA", "{}");
    expect(loadConfig({ cwd }).customMetadata).toMatchObject({ 0: true, winner: 3 });
    for (const file of files.slice(1)) writeFileSync(file, "{}");
    expect(loadConfig({ cwd }).customMetadata).toMatchObject({
      0: true,
      winner: 0,
      nested: { 0: true },
    });
  });

  it.each([0, 1, 2, 3])(
    "opposing environment booleans override file layer %s both ways",
    (index) => {
      for (const value of [true, false]) {
        write(index, { enabled: !value, defaultMuted: !value });
        vi.stubEnv("TRACE_TO_LANGSMITH", String(value));
        vi.stubEnv("LANGSMITH_CURSOR_DEFAULT_MUTED", String(value));
        expect(loadConfig({ cwd })).toMatchObject({ enabled: value, defaultMuted: value });
      }
    },
  );

  it.each([0, 1, 2, 3])(
    "unhealthy layer %s allows independent higher env fields and ordinary lower fallback",
    (index) => {
      write(0, { project: "home", api_key: "home-key", attachments: false });
      writeFileSync(files[index], "{broken");
      expect(loadConfig({ cwd })).toMatchObject({
        enabled: false,
        defaultMuted: true,
        project: index === 0 ? "cursor" : "home",
        apiKey: index === 0 ? "" : "home-key",
      });
      vi.stubEnv("TRACE_TO_LANGSMITH", "true");
      expect(loadConfig({ cwd })).toMatchObject({ enabled: true, defaultMuted: true });
      vi.stubEnv("TRACE_TO_LANGSMITH", undefined);
      vi.stubEnv("LANGSMITH_CURSOR_DEFAULT_MUTED", "false");
      expect(loadConfig({ cwd })).toMatchObject({ enabled: false, defaultMuted: false });
      vi.stubEnv("TRACE_TO_LANGSMITH", "true");
      expect(loadConfig({ cwd })).toMatchObject({ enabled: true, defaultMuted: false });
    },
  );

  it.each(["attachments", "system_prompt", "cursor_db_path"] as const)(
    "home %s extension validates independently from common fields and other extensions",
    (field) => {
      vi.spyOn(logger, "error").mockImplementation(() => {});
      write(0, {
        enabled: true,
        api_key: "home-key",
        attachments: false,
        system_prompt: false,
        cursor_db_path: "home-db",
        [field]: null,
      });
      expect(loadConfig({ cwd })).toMatchObject({
        enabled: true,
        apiKey: "home-key",
        attachmentsEnabled: field === "attachments",
        systemPromptEnabled: field === "system_prompt",
        cursorDbPath: field === "cursor_db_path" ? undefined : "home-db",
      });
      write(0, {
        project: null,
        attachments: false,
        system_prompt: false,
        cursor_db_path: "home-db",
      });
      expect(loadConfig({ cwd })).toMatchObject({
        enabled: false,
        defaultMuted: true,
        attachmentsEnabled: false,
        systemPromptEnabled: false,
        cursorDbPath: "home-db",
      });
    },
  );

  it.each(["true", "1", "yes", "on", " true ", " FALSE ", "0", "no", "off", "", "unknown"])(
    "master aliases stay separate from strict default mute: %j",
    (value) => {
      write(0, { enabled: true, defaultMuted: false });
      vi.stubEnv("TRACE_TO_LANGSMITH", value);
      vi.stubEnv("LANGSMITH_CURSOR_DEFAULT_MUTED", value);
      expect(loadConfig({ cwd })).toMatchObject({
        enabled: ["true", "1", "yes", "on"].includes(value.trim().toLowerCase()),
        defaultMuted: value.toLowerCase() !== "false",
      });
    },
  );
});
