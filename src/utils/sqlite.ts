import { createRequire } from "node:module";
import { SQLITE_EXPERIMENTAL_WARNING } from "../constants.js";

const requireBuiltin = createRequire(import.meta.url);

/** Loads `node:sqlite` without letting Node's one-time "experimental" notice reach a hook's stderr. */
export function loadSqlite(): typeof import("node:sqlite") {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === "string" ? warning : warning.message;
    if (SQLITE_EXPERIMENTAL_WARNING.test(message)) return;
    return (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return requireBuiltin("node:sqlite");
  } finally {
    process.emitWarning = emitWarning;
  }
}
