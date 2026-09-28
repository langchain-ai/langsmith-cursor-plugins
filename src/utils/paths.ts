import { realpathSync, statSync } from "node:fs";

function resolvesToTheSamePath(one: string, other: string): boolean {
  try {
    return realpathSync(one) === realpathSync(other);
  } catch {
    return one === other;
  }
}

export function isTheSameFile(one: string, other: string): boolean {
  try {
    const first = statSync(one);
    const second = statSync(other);
    return first.dev === second.dev && first.ino === second.ino;
  } catch {
    return resolvesToTheSamePath(one, other);
  }
}
