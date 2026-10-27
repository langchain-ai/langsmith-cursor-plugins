import { WHITESPACE_RUN } from "../constants.js";

/** Collapse whitespace runs so a typed prompt matches the stored bubble text. */
export function normalizeWs(text: string): string {
  return text.replace(WHITESPACE_RUN, " ").trim();
}

export function readableText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return String(value);
  const entries = Array.isArray(value)
    ? value.map((item): [string, unknown] => ["-", item])
    : Object.entries(value).map(([key, item]): [string, unknown] => [`${key}:`, item]);
  return entries
    .map(([label, item]) => {
      const text = readableText(item);
      return text.includes("\n") || (item !== null && typeof item === "object")
        ? `${label}\n${text}`
        : `${label} ${text}`;
    })
    .join("\n");
}
