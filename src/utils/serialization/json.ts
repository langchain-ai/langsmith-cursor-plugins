import type { JsonValue } from "@langchain/plugins-base/storage/capture";

export function toJsonValue(value: unknown, errorMessage: string): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError(errorMessage);
  return JSON.parse(encoded) as JsonValue;
}
