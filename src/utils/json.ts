/** A deep copy that drops `undefined` values, as the wire format will. */
export function withoutUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
