import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { buildSync } from "esbuild";
import {
  getThreadTracingMode,
  parseTracingCommand,
  setThreadTracingMode,
  tracingPolicyPath,
} from "../src/tracing-policy.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

let dir: string;
let state: string;
let policy: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tracing-policy-"));
  state = join(dir, "state.json");
  policy = join(dir, "state.privacy.json");
  vi.stubEnv("LANGSMITH_CURSOR_PRIVACY_FILE", policy);
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

type FsFault =
  | "directory open"
  | "directory sync"
  | "directory close"
  | "lock rmdir"
  | "temp writeFile"
  | "temp sync"
  | "temp close"
  | "temp unlink";

// Use real files/rename so assertions cover the effective on-disk preference.
function injectFsFaults(...faults: FsFault[]) {
  const originalOpen = fsPromises.open;
  const originalUnlink = fsPromises.unlink;
  const originalRmdir = fsPromises.rmdir;
  vi.spyOn(fsPromises, "open").mockImplementation(async (path, flags, mode) => {
    const kind = String(path) === dir ? "directory" : "temp";
    if (faults.includes(`${kind} open` as FsFault)) throw new Error(`${kind} open failed`);
    const handle = await originalOpen(path, flags, mode);
    for (const method of ["writeFile", "sync", "close"] as const) {
      if (!faults.includes(`${kind} ${method}` as FsFault)) continue;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, method).mockImplementation(async () => {
        // Release real descriptors even when simulating a close error.
        if (method === "close") await close();
        throw new Error(`${kind} ${method} failed`);
      });
    }
    return handle;
  });
  vi.spyOn(fsPromises, "unlink").mockImplementation(async (path) => {
    if (faults.includes("temp unlink")) throw new Error("temp unlink failed");
    return originalUnlink(path);
  });
  vi.spyOn(fsPromises, "rmdir").mockImplementation(async (path) => {
    if (faults.includes("lock rmdir")) throw new Error("lock rmdir failed");
    return originalRmdir(path);
  });
}

const postcommitFaults: FsFault[] = [
  "directory open",
  "directory sync",
  "directory close",
  "lock rmdir",
];

describe("standalone tracing preference", () => {
  it("uses an independent configured privacy path", () => expect(tracingPolicyPath()).toBe(policy));

  it("defaults absent/new healthy threads to full and persists only selected threads", async () => {
    expect(getThreadTracingMode(policy, "new")).toBe("full");
    expect(existsSync(policy)).toBe(false);
    await setThreadTracingMode(policy, "a", "metadata");
    expect(getThreadTracingMode(policy, "a")).toBe("metadata");
    expect(getThreadTracingMode(policy, "b")).toBe("full");
    await setThreadTracingMode(policy, "b", "metadata");
    await setThreadTracingMode(policy, "a", "full");
    expect(getThreadTracingMode(policy, "a")).toBe("full");
    expect(getThreadTracingMode(policy, "b")).toBe("metadata");
    expect(statSync(policy).mode & 0o777).toBe(0o600);
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
      Array.from({ length: 24 }, (_, i) => setThreadTracingMode(policy, `s${i}`, "metadata")),
    );
    for (let i = 0; i < 24; i++) expect(getThreadTracingMode(policy, `s${i}`)).toBe("metadata");
  });

  it("serializes concurrent edits across actual processes", async () => {
    const bundle = join(dir, "policy.mjs");
    buildSync({
      entryPoints: [fileURLToPath(new URL("../src/tracing-policy.ts", import.meta.url))],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "esm",
    });
    const run = promisify(execFile);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        run(process.execPath, [
          "--input-type=module",
          "-e",
          `import { setThreadTracingMode } from ${JSON.stringify(pathToFileURL(bundle).href)}; await setThreadTracingMode(${JSON.stringify(policy)}, 'process-${i}', 'metadata');`,
        ]),
      ),
    );
    for (let i = 0; i < 8; i++)
      expect(getThreadTracingMode(policy, `process-${i}`)).toBe("metadata");
  });

  it("keeps the old policy and cleans up after atomic rename failure", async () => {
    await setThreadTracingMode(policy, "a", "metadata");
    const before = readFileSync(policy, "utf8");
    vi.spyOn(fsPromises, "rename").mockRejectedValueOnce(new Error("rename failed"));
    await expect(setThreadTracingMode(policy, "a", "full")).rejects.toThrow("rename failed");
    expect(readFileSync(policy, "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual(["state.privacy.json"]);
  });

  it.each(postcommitFaults)("returns a warning after committed %s failure", async (fault) => {
    await setThreadTracingMode(policy, "a", "metadata");
    injectFsFaults(fault);
    const result = await setThreadTracingMode(policy, "a", "full");
    expect(result.warning).toContain(`${fault} failed`);
    expect(getThreadTracingMode(policy, "a")).toBe("full");
    expect(existsSync(`${policy}.lock`)).toBe(fault === "lock rmdir");
    if (fault === "directory open" || fault === "directory sync") {
      expect(result.warning).toContain("crash durability");
      expect(result.warning).toContain("retry saving");
    }
    if (fault === "lock rmdir") expect(result.warning).toContain("no preference writer is running");
  });

  it("attempts all postcommit cleanup independently", async () => {
    injectFsFaults("directory sync", "directory close", "lock rmdir");
    const result = await setThreadTracingMode(policy, "a", "metadata");
    for (const fault of ["directory sync", "directory close", "lock rmdir"]) {
      expect(result.warning).toContain(`${fault} failed`);
    }
    expect(getThreadTracingMode(policy, "a")).toBe("metadata");
  });

  it.each(["temp writeFile", "temp sync", "temp close"] as FsFault[])(
    "preserves the old policy on precommit %s failure",
    async (fault) => {
      await setThreadTracingMode(policy, "a", "metadata");
      const before = readFileSync(policy, "utf8");
      injectFsFaults(fault);
      await expect(setThreadTracingMode(policy, "a", "full")).rejects.toThrow(`${fault} failed`);
      expect(readFileSync(policy, "utf8")).toBe(before);
      expect(readdirSync(dir)).toEqual(["state.privacy.json"]);
    },
  );

  it.each(["write", "rename"])("does not mask %s errors with cleanup errors", async (failure) => {
    await setThreadTracingMode(policy, "a", "metadata");
    const before = readFileSync(policy, "utf8");
    injectFsFaults(
      "temp unlink",
      "lock rmdir",
      ...(failure === "write" ? (["temp writeFile", "temp close"] as FsFault[]) : []),
    );
    if (failure === "rename")
      vi.spyOn(fsPromises, "rename").mockRejectedValueOnce(new Error("rename failed"));
    await expect(setThreadTracingMode(policy, "a", "full")).rejects.toThrow(
      failure === "write" ? "temp writeFile failed" : "rename failed",
    );
    expect(readFileSync(policy, "utf8")).toBe(before);
    expect(fsPromises.rmdir).toHaveBeenCalledWith(`${policy}.lock`);
    expect(fsPromises.unlink).toHaveBeenCalledTimes(1);
  });

  it.each(["directory", "legacy file"])(
    "times out rather than stealing even an old live %s lock",
    async (kind) => {
      await setThreadTracingMode(policy, "a", "metadata");
      const before = readFileSync(policy, "utf8");
      if (kind === "directory") mkdirSync(`${policy}.lock`);
      else writeFileSync(`${policy}.lock`, `${process.pid}\n`);
      utimesSync(`${policy}.lock`, new Date(0), new Date(0));
      await expect(setThreadTracingMode(policy, "a", "full")).rejects.toThrow("Timed out");
      if (kind === "directory") expect(readdirSync(`${policy}.lock`)).toEqual([]);
      else expect(readFileSync(`${policy}.lock`, "utf8")).toBe(`${process.pid}\n`);
      expect(readFileSync(policy, "utf8")).toBe(before);
    },
  );

  it("holds a private, empty directory lock until the write completes", async () => {
    const originalRename = fsPromises.rename;
    vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
      expect(statSync(`${policy}.lock`).isDirectory()).toBe(true);
      expect(statSync(`${policy}.lock`).mode & 0o777).toBe(0o700);
      expect(readdirSync(`${policy}.lock`)).toEqual([]);
      return originalRename(from, to);
    });
    const mkdir = vi.spyOn(fsPromises, "mkdir");
    await setThreadTracingMode(policy, "a", "metadata");
    expect(mkdir).toHaveBeenCalledWith(`${policy}.lock`, { mode: 0o700 });
    expect(existsSync(`${policy}.lock`)).toBe(false);
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
      await fsPromises.rmdir(`${policy}.lock`);
      await save;
    }
    expect(getThreadTracingMode(policy, "a")).toBe("metadata");
    expect(existsSync(`${policy}.lock`)).toBe(false);
  });

  it("propagates lock acquisition errors without changing preferences", async () => {
    await setThreadTracingMode(policy, "a", "metadata");
    const before = readFileSync(policy, "utf8");
    const originalMkdir = fsPromises.mkdir;
    vi.spyOn(fsPromises, "mkdir").mockImplementation(async (path, options) => {
      if (String(path) === `${policy}.lock`) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return originalMkdir(path, options);
    });
    const rmdir = vi.spyOn(fsPromises, "rmdir");
    await expect(setThreadTracingMode(policy, "a", "full")).rejects.toThrow("permission denied");
    expect(readFileSync(policy, "utf8")).toBe(before);
    expect(rmdir).not.toHaveBeenCalled();
  });
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
