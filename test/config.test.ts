import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseRepoName } from "../src/config.js";

function writeCursorConfig(dir: string, cfg: Record<string, unknown>): void {
  mkdirSync(join(dir, ".cursor"), { recursive: true });
  writeFileSync(join(dir, ".cursor", "langsmith.json"), JSON.stringify(cfg));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

function clearEnv(): void {
  for (const k of [
    "TRACE_TO_LANGSMITH",
    "LANGSMITH_API_KEY",
    "LANGSMITH_CURSOR_API_KEY",
    "LANGSMITH_ENDPOINT",
    "LANGSMITH_CURSOR_ENDPOINT",
    "LANGSMITH_PROJECT",
    "LANGSMITH_CURSOR_PROJECT",
    "LANGSMITH_CURSOR_DEBUG",
    "LANGSMITH_CURSOR_STATE_FILE",
    "LANGSMITH_CURSOR_STEP_FIDELITY",
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
    expect(cfg.enabled).toBe(true);
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

  it("defaults stepFidelityEnabled ON and honors the env opt-out", () => {
    clearEnv();
    const home = mkdtempSync(join(tmpdir(), "home-"));
    vi.stubEnv("HOME", home);

    expect(loadConfig({ cwd: home }).stepFidelityEnabled).toBe(true);

    vi.stubEnv("LANGSMITH_CURSOR_STEP_FIDELITY", "off");
    expect(loadConfig({ cwd: home }).stepFidelityEnabled).toBe(false);
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
