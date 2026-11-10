import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { LINE_READ_CHUNK_BYTES } from "../constants.js";

export function* readLines(path: string): Generator<string> {
  const fd = openSync(path, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const chunk = Buffer.alloc(LINE_READ_CHUNK_BYTES);
    let rest = "";
    let bytes: number;
    while ((bytes = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      const lines = (rest + decoder.write(chunk.subarray(0, bytes))).split("\n");
      rest = lines.pop() ?? "";
      yield* lines;
    }
    yield rest + decoder.end();
  } finally {
    closeSync(fd);
  }
}
