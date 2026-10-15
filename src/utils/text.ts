import { WHITESPACE_RUN } from "../constants.js";

/** Collapse whitespace runs so a typed prompt matches the stored bubble text. */
export function normalizeWs(text: string): string {
  return text.replace(WHITESPACE_RUN, " ").trim();
}
