import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getThreadTracingMode,
  parseTracingCommand,
  setThreadTracingMode,
  tracingPolicyPath,
} from "../src/tracing-policy.js";

let dir: string;
let state: string;
let policy: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tracing-policy-"));
  state = join(dir, "state.json");
  policy = join(dir, "state.privacy.json");
  vi.stubEnv("LANGSMITH_CURSOR_PRIVACY_FILE", policy);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("mute choices kept by 0.5.0", () => {
  it("are honored on first use under the new name and left in place for a rollback", async () => {
    const legacy = join(dir, "langsmith-state.privacy.json");
    writeFileSync(legacy, JSON.stringify({ threads: { muted: "metadata" } }));
    const renamed = join(dir, "langsmith_state_privacy.json");
    expect(getThreadTracingMode(renamed, "muted")).toBe("metadata");
    await setThreadTracingMode(renamed, "other", "metadata");
    expect(getThreadTracingMode(renamed, "muted")).toBe("metadata");
    expect(JSON.parse(readFileSync(legacy, "utf8"))).toEqual({ threads: { muted: "metadata" } });
  });
});

describe("standalone tracing preference", () => {
  it("uses an independent configured privacy path", () => expect(tracingPolicyPath()).toBe(policy));

  it("defaults absent/new healthy threads to full and persists only selected threads", async () => {
    expect(getThreadTracingMode(policy, "new")).toBe("full");
    expect(getThreadTracingMode(policy, "new", true)).toBe("metadata");
    expect(existsSync(policy)).toBe(false);
    await setThreadTracingMode(policy, "a", "metadata");
    expect(getThreadTracingMode(policy, "a")).toBe("metadata");
    expect(getThreadTracingMode(policy, "b")).toBe("full");
    await setThreadTracingMode(policy, "b", "metadata");
    await setThreadTracingMode(policy, "a", "full");
    expect(getThreadTracingMode(policy, "a")).toBe("full");
    expect(getThreadTracingMode(policy, "b")).toBe("metadata");
    if (process.platform !== "win32") expect(statSync(policy).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["state.privacy.json"]);
  });

  it("creates missing parents and leaves existing tracing state untouched", async () => {
    writeFileSync(state, "current interrupted turn: do not reset");
    await setThreadTracingMode(policy, "a", "metadata");
    expect(readFileSync(state, "utf8")).toBe("current interrupted turn: do not reset");
    rmSync(state); // Simulate pruning/deletion independently of preferences.
    expect(getThreadTracingMode(policy, "a")).toBe("metadata");
    const nested = join(dir, "nested", "deep", "state.json");
    await setThreadTracingMode(nested, "a", "metadata");
    expect(getThreadTracingMode(nested, "a")).toBe("metadata");
    expect(existsSync(nested)).toBe(true);
  });

  it.each(["__proto__", "constructor", "toString"])("handles session key %s", async (id) => {
    expect(getThreadTracingMode(policy, id)).toBe("full");
    await setThreadTracingMode(policy, id, "metadata");
    expect(getThreadTracingMode(policy, id)).toBe("metadata");
  });

  it("honors the configured default without losing explicit preferences", async () => {
    writeFileSync(policy, JSON.stringify({ threads: { a: "metadata" } }));
    await setThreadTracingMode(policy, "b", "full");
    expect(getThreadTracingMode(policy, "unknown", true)).toBe("metadata");
    expect(getThreadTracingMode(policy, "unknown", false)).toBe("full");
    expect(getThreadTracingMode(policy, "a")).toBe("metadata");
    expect(getThreadTracingMode(policy, "b", true)).toBe("full");
    expect(JSON.parse(readFileSync(policy, "utf8"))).toEqual({
      threads: { a: "metadata", b: "full" },
    });
  });

  it.each([
    "not json",
    "null",
    "[]",
    "{}",
    '{"threads":[]}',
    '{"threads":{"a":"metadata","b":"invalid"}}',
    '{"default":"full","threads":{}}',
    '{"threads":{},"future":true}',
  ])("fails closed and refuses to overwrite malformed policy %s", async (raw) => {
    writeFileSync(policy, raw);
    expect(getThreadTracingMode(policy, "new")).toBe("metadata");
    await expect(setThreadTracingMode(policy, "new", "full")).rejects.toThrow("repair the file");
    expect(readFileSync(policy, "utf8")).toBe(raw);
    expect(existsSync(`${policy}.lock`)).toBe(false);
  });

  it("fails closed on read errors, including dangling symlinks, and refuses writes", async () => {
    mkdirSync(policy);
    expect(getThreadTracingMode(policy, "a")).toBe("metadata");
    await expect(setThreadTracingMode(policy, "a", "full")).rejects.toThrow(
      "Refusing to overwrite",
    );
    rmSync(policy, { recursive: true });
    symlinkSync(join(dir, "missing"), policy);
    expect(getThreadTracingMode(policy, "a")).toBe("metadata");
    await expect(setThreadTracingMode(policy, "a", "full")).rejects.toThrow(
      "Refusing to overwrite",
    );
    expect(lstatSync(policy).isSymbolicLink()).toBe(true);
  });

  it("serializes concurrent edits within a process", async () => {
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => setThreadTracingMode(policy, `s${i}`, "metadata")),
    );
    for (let i = 0; i < 6; i++) expect(getThreadTracingMode(policy, `s${i}`)).toBe("metadata");
  });

  it("retries until a held directory lock is released", async () => {
    mkdirSync(`${policy}.lock`);
    let finished = false;
    const save = setThreadTracingMode(policy, "a", "metadata").then(() => {
      finished = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(finished).toBe(false);
      expect(existsSync(policy)).toBe(false);
    } finally {
      rmdirSync(`${policy}.lock`);
      await save;
    }
    expect(getThreadTracingMode(policy, "a")).toBe("metadata");
  });

  it("tells the user how to recover when an older plugin version still holds the lock", async () => {
    await setThreadTracingMode(policy, "a", "metadata");
    const before = readFileSync(policy, "utf8");
    mkdirSync(`${policy}.lock`);
    try {
      await expect(setThreadTracingMode(policy, "a", "full")).rejects.toThrow(
        "Timed out waiting for tracing preference lock",
      );
    } finally {
      rmdirSync(`${policy}.lock`);
    }
    expect(readFileSync(policy, "utf8")).toBe(before);
  });

  it("leaves the lock free for an older plugin version once a save finishes", async () => {
    await setThreadTracingMode(policy, "a", "metadata");
    expect(() => mkdirSync(`${policy}.lock`)).not.toThrow();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses to save, and keeps the old preference, when the folder cannot be written",
    async () => {
      await setThreadTracingMode(policy, "a", "metadata");
      const before = readFileSync(policy, "utf8");
      chmodSync(dir, 0o555);
      try {
        await expect(setThreadTracingMode(policy, "a", "full")).rejects.toThrow();
      } finally {
        chmodSync(dir, 0o755);
      }
      expect(readFileSync(policy, "utf8")).toBe(before);
    },
  );
});

describe("exact command parser", () => {
  it.each(["mute", "unmute"] as const)("recognizes %s", (cmd) => {
    expect(parseTracingCommand(`langsmith-tracing:${cmd}`)).toBe(cmd);
  });
  it.each([
    "",
    "/mute",
    "/langsmith-tracing:mute",
    "/langsmith-tracing:unmute",
    "langsmith-tracing:mute now",
    "langsmith-tracing:unmute now",
    " langsmith-tracing:mute",
    "langsmith-tracing:mute\n",
    "langsmith-tracing:MUTE",
    "please langsmith-tracing:mute",
    "langsmith-tracing:muted",
  ])("does not handle %j", (prompt) => expect(parseTracingCommand(prompt)).toBeUndefined());
});

it("rejects even a readable symlink policy without overwriting its target", async () => {
  const target = join(dir, "target.json");
  writeFileSync(target, JSON.stringify({ threads: {} }));
  symlinkSync(target, policy);
  expect(getThreadTracingMode(policy, "thread")).toBe("metadata");
  await expect(setThreadTracingMode(policy, "thread", "full")).rejects.toThrow("Refusing");
  expect(lstatSync(policy).isSymbolicLink()).toBe(true);
  expect(JSON.parse(readFileSync(target, "utf8")).threads).toEqual({});
});
