import type { TracingMode } from "../types.js";

export interface TracingPolicy {
  threads: Record<string, TracingMode>;
}
