import { Readable } from "node:stream";
import { expect, it } from "vitest";

import { readStdin } from "../../src/utils/stdin.js";

const TURN = '{"hook_event_name":"stop"}';

it("reads a turn Windows marked as UTF-8 before handing it over", async () => {
  await expect(readStdin(Readable.from([`﻿﻿${TURN}`]))).resolves.toEqual({
    hook_event_name: "stop",
  });
});

it("reads a turn that arrives in pieces, and says so when it is not a turn at all", async () => {
  await expect(readStdin(Readable.from(['{"hook_event', '_name":"stop"}']))).resolves.toEqual({
    hook_event_name: "stop",
  });
  await expect(readStdin(Readable.from(["not a turn"]))).rejects.toThrow(
    "Failed to parse hook input",
  );
});
