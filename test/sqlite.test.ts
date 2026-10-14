import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:module", () => ({
  createRequire: () => () => {
    process.emitWarning("SQLite is an experimental feature and might change at any time");
    process.emitWarning("something else worth showing");
    return { DatabaseSync: class {} };
  },
}));

import { loadSqlite } from "../src/utils/sqlite.js";

const original = process.emitWarning;
afterEach(() => {
  process.emitWarning = original;
});

it("drops only Node's SQLite experimental notice while loading, and restores warnings afterwards", () => {
  const seen: unknown[] = [];
  process.emitWarning = ((warning: unknown) =>
    void seen.push(warning)) as typeof process.emitWarning;
  const spy = process.emitWarning;

  expect(loadSqlite()).toHaveProperty("DatabaseSync");

  expect(seen).toEqual(["something else worth showing"]);
  expect(process.emitWarning).toBe(spy);
});
