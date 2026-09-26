import { realpathSync } from "node:fs";

export function isTheSameFile(one: string, other: string): boolean {
  try {
    return realpathSync(one) === realpathSync(other);
  } catch {
    return one === other;
  }
}
