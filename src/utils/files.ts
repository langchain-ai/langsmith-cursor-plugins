import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { LINE_READ_CHUNK_BYTES } from "../constants.js";

export function* readLines(path: string): Generator<string> {
  const fd = openSync(path, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const chunk = Buffer.alloc(LINE_READ_CHUNK_BYTES);
    let pending: string[] = [];
    let bytes: number;
    while ((bytes = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      const text = decoder.write(chunk.subarray(0, bytes));
      let start = 0;
      let end: number;
      while ((end = text.indexOf("\n", start)) !== -1) {
        yield pending.join("") + text.slice(start, end);
        pending = [];
        start = end + 1;
      }
      pending.push(text.slice(start));
    }
    yield pending.join("") + decoder.end();
  } finally {
    closeSync(fd);
  }
}
