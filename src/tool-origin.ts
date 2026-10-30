import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ReconstructionToolOrigin } from "@langchain/plugins-base/tracing/reconstruction";
import { TOOL_PATH_INPUT_KEYS } from "./constants.js";
import type { ToolEvent } from "./models/types.js";
import { isRecord } from "./normalize.js";

export function toolRoots(tools: ToolEvent[]): Map<string, string | undefined> {
  return new Map(tools.map((tool) => [tool.tool_use_id, tool.workspace_root]));
}

export function toolOrigin(toolInput: unknown, cwd: string): ReconstructionToolOrigin {
  if (!isRecord(toolInput)) return { cwd, namedAPath: false };
  let namedAPath = false;
  for (const key of TOOL_PATH_INPUT_KEYS) {
    const value = toolInput[key];
    if (typeof value !== "string" || value.length === 0) continue;
    namedAPath = true;
    if (isAbsolute(value)) return { cwd, path: value, namedAPath };
    const resolved = resolve(cwd, value);
    if (isAbsolute(cwd) && existsSync(resolved)) return { cwd, path: resolved, namedAPath };
  }
  return { cwd, namedAPath };
}
