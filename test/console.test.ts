import { expect, it } from "vitest";
import { withWarningsTo } from "../src/utils/console.js";

it("sends warnings to the sink instead of stderr, and puts console.warn back even when the work throws", async () => {
  const original = console.warn;
  const seen: string[] = [];
  await expect(
    withWarningsTo(
      (message) => seen.push(message),
      async () => {
        console.warn("waiting for another setting:", 7);
        throw new Error("boom");
      },
    ),
  ).rejects.toThrow("boom");
  expect(seen).toEqual(["waiting for another setting: 7"]);
  expect(console.warn).toBe(original);
});
