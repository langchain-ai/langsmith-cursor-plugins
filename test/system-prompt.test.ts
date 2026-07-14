import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readProtoLenField,
  decodeConversationStateBlob,
  systemContentOf,
  resolveTurnSystemPrompt,
  resolveSystemPrompts,
  type BlobReader,
} from "../src/system-prompt.js";

// ─── Minimal protobuf encoders (mirror Cursor's wire output) ─────────────────

function varint(n: number): number[] {
  const bytes: number[] = [];
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  bytes.push(n);
  return bytes;
}
/** field < 16 fits the tag in one byte. */
function lenField(field: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([(field << 3) | 2, ...varint(value.length)]), value]);
}
function varintField(field: number, value: number): Buffer {
  return Buffer.from([(field << 3) | 0, ...varint(value)]);
}

describe("readProtoLenField", () => {
  it("collects repeated length-delimited values for one field, skipping all others", () => {
    const blob = Buffer.concat([
      lenField(1, Buffer.from("aa", "hex")),
      varintField(2, 42), // wire type 0 — skipped
      lenField(1, Buffer.from("bb", "hex")),
      lenField(3, Buffer.from("noise")), // other LEN field — skipped
      Buffer.from([(4 << 3) | 5, 1, 2, 3, 4]), // 32-bit — skipped
      Buffer.from([(5 << 3) | 1, 1, 2, 3, 4, 5, 6, 7, 8]), // 64-bit — skipped
      lenField(1, Buffer.from("cc", "hex")),
    ]);
    const got = readProtoLenField(blob, 1).map((b) => b.toString("hex"));
    expect(got).toEqual(["aa", "bb", "cc"]);
  });

  it("handles multi-byte varint lengths (value > 127 bytes)", () => {
    const big = Buffer.alloc(200, 0x41);
    const blob = lenField(1, big);
    const got = readProtoLenField(blob, 1);
    expect(got).toHaveLength(1);
    expect(got[0].length).toBe(200);
  });

  it("returns [] on a truncated length-delimited field rather than throwing", () => {
    const blob = Buffer.from([(1 << 3) | 2, 50, 0x01, 0x02]); // claims 50 bytes, has 2
    expect(readProtoLenField(blob, 1)).toEqual([]);
  });
});

describe("decodeConversationStateBlob", () => {
  it("decodes a '~'-prefixed base64 value", () => {
    const raw = "~" + Buffer.from("hello").toString("base64");
    expect(decodeConversationStateBlob(raw)?.toString()).toBe("hello");
  });
  it("decodes a bare hex value", () => {
    expect(decodeConversationStateBlob("68656c6c6f")?.toString()).toBe("hello");
  });
  it("returns undefined for empty / non-string input", () => {
    expect(decodeConversationStateBlob("")).toBeUndefined();
    expect(decodeConversationStateBlob("~")).toBeUndefined();
    expect(decodeConversationStateBlob(undefined)).toBeUndefined();
    expect(decodeConversationStateBlob(42)).toBeUndefined();
  });
});

describe("systemContentOf", () => {
  it("returns the content of a role:system message", () => {
    const buf = Buffer.from(JSON.stringify({ role: "system", content: "You are…" }));
    expect(systemContentOf(buf)).toBe("You are…");
  });
  it("stringifies array-of-parts content", () => {
    const buf = Buffer.from(JSON.stringify({ role: "system", content: [{ type: "text" }] }));
    expect(systemContentOf(buf)).toBe('[{"type":"text"}]');
  });
  it("ignores non-system messages, empty content, and malformed JSON", () => {
    expect(
      systemContentOf(Buffer.from(JSON.stringify({ role: "user", content: "hi" }))),
    ).toBeUndefined();
    expect(
      systemContentOf(Buffer.from(JSON.stringify({ role: "system", content: "" }))),
    ).toBeUndefined();
    expect(systemContentOf(Buffer.from("not json"))).toBeUndefined();
  });
});

describe("resolveTurnSystemPrompt", () => {
  // A real (empty) file so existsSync(dbPath) passes; the reader is injected.
  function tmpDb(): string {
    const path = join(mkdtempSync(join(tmpdir(), "sysprompt-")), "state.vscdb");
    writeFileSync(path, "");
    return path;
  }

  function mapReader(map: Map<string, Buffer>): (dbPath: string) => BlobReader {
    return () => ({ get: (k) => map.get(k), close: () => {} });
  }

  it("walks composerData → blob ids → the system message", () => {
    const idUser = Buffer.from([0xde, 0xad]);
    const idSystem = Buffer.from([0xbe, 0xef]);
    const stateBlob = Buffer.concat([lenField(1, idUser), lenField(1, idSystem)]);
    const conversationState = "~" + stateBlob.toString("base64");

    const map = new Map<string, Buffer>([
      ["composerData:conv1", Buffer.from(JSON.stringify({ conversationState }))],
      ["agentKv:blob:dead", Buffer.from(JSON.stringify({ role: "user", content: "hi" }))],
      [
        "agentKv:blob:beef",
        Buffer.from(JSON.stringify({ role: "system", content: "SYSTEM PROMPT" })),
      ],
    ]);

    const got = resolveTurnSystemPrompt({
      conversationId: "conv1",
      dbPath: tmpDb(),
      openReader: mapReader(map),
    });
    expect(got).toBe("SYSTEM PROMPT");
  });

  it("returns undefined when no composerData / no system message exists", () => {
    const empty = resolveTurnSystemPrompt({
      conversationId: "missing",
      dbPath: tmpDb(),
      openReader: mapReader(new Map()),
    });
    expect(empty).toBeUndefined();

    const stateBlob = lenField(1, Buffer.from([0x01]));
    const noSystem = new Map<string, Buffer>([
      [
        "composerData:conv2",
        Buffer.from(JSON.stringify({ conversationState: "~" + stateBlob.toString("base64") })),
      ],
      ["agentKv:blob:01", Buffer.from(JSON.stringify({ role: "user", content: "hi" }))],
    ]);
    expect(
      resolveTurnSystemPrompt({
        conversationId: "conv2",
        dbPath: tmpDb(),
        openReader: mapReader(noSystem),
      }),
    ).toBeUndefined();
  });

  it("returns undefined (never throws) when the DB path does not exist", () => {
    expect(
      resolveTurnSystemPrompt({ conversationId: "conv1", dbPath: "/no/such/state.vscdb" }),
    ).toBeUndefined();
  });

  it("resolveSystemPrompts opens ONE connection for many conversations (deduped)", () => {
    const stateOf = (idByte: number) => "~" + lenField(1, Buffer.from([idByte])).toString("base64");
    const map = new Map<string, Buffer>([
      ["composerData:a", Buffer.from(JSON.stringify({ conversationState: stateOf(0xa1) }))],
      ["composerData:b", Buffer.from(JSON.stringify({ conversationState: stateOf(0xb2) }))],
      ["agentKv:blob:a1", Buffer.from(JSON.stringify({ role: "system", content: "SYS A" }))],
      ["agentKv:blob:b2", Buffer.from(JSON.stringify({ role: "system", content: "SYS B" }))],
    ]);
    let opens = 0;
    let closes = 0;
    const openReader = (): BlobReader => {
      opens++;
      return { get: (k) => map.get(k), close: () => void closes++ };
    };

    const got = resolveSystemPrompts({
      conversationIds: ["a", "b", "a"], // duplicate is deduped
      dbPath: tmpDb(),
      openReader,
    });

    expect(opens).toBe(1);
    expect(closes).toBe(1);
    expect(got.get("a")).toBe("SYS A");
    expect(got.get("b")).toBe("SYS B");
  });
});
