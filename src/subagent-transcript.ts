/**
 * On-disk subagent transcript resolution.
 *
 * The subagent hooks (subagentStart/Stop) never tell us the subagent's own
 * conversation_id, and they carry only the *parent* transcript_path. But Cursor
 * writes each subagent's transcript to a sibling `subagents/<child_conv>.jsonl`
 * file whose basename IS the child conversation_id. We locate the right file by
 * matching the task text, which gives us both:
 *   - the child conversation_id (to splice in the child's buffered tool events), and
 *   - the subagent's final answer text (recorded nowhere else).
 *
 * This is best-effort, synchronous, and never throws: any failure returns
 * undefined and the caller falls back to in-memory temporal linking.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { parseSubagentTranscript, type SubagentToolCall } from "./normalize.js";
import { isRecord } from "./normalize.js";

export interface ResolvedSubagentTranscript {
  /** Basename of the matched transcript file (= the subagent's conversation_id). */
  childConversationId: string;
  toolCalls: SubagentToolCall[];
  resultText?: string;
}

/** Collapse all whitespace runs to single spaces for tolerant matching. */
function normalizeWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function readJsonl(path: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      /* skip malformed line */
    }
  }
  return rows;
}

/** Concatenate the text parts of the first user row. */
function firstUserText(rows: unknown[]): string {
  for (const row of rows) {
    if (!isRecord(row) || row.role !== "user") continue;
    const content = isRecord(row.message) ? row.message.content : undefined;
    if (!Array.isArray(content)) continue;
    return content
      .filter((p): p is Record<string, unknown> => isRecord(p) && p.type === "text")
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("");
  }
  return "";
}

/**
 * Find and parse the subagent transcript for `task` under the parent
 * transcript's `subagents/` directory. Matches by task-text prefix; when a task
 * is unavailable or several files match, falls back to the most recently
 * modified file (single-subagent case — parallel workers are deferred).
 */
export function resolveSubagentTranscript(
  parentTranscriptPath: string | null | undefined,
  task: string | undefined,
): ResolvedSubagentTranscript | undefined {
  if (!parentTranscriptPath) return undefined;
  try {
    const dir = join(dirname(parentTranscriptPath), "subagents");
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0) return undefined;

    const candidates = files.map((f) => {
      const full = join(dir, f);
      return { full, child: basename(f, ".jsonl"), mtime: statSync(full).mtimeMs };
    });

    const wanted = task ? normalizeWs(task).slice(0, 120) : "";
    let chosen: (typeof candidates)[number] & { rows?: unknown[] };

    if (candidates.length === 1) {
      chosen = candidates[0];
    } else {
      const matches = candidates
        .map((c) => ({ ...c, rows: readJsonl(c.full) }))
        .filter((c) => wanted !== "" && normalizeWs(firstUserText(c.rows)).includes(wanted));
      const pool = matches.length > 0 ? matches : candidates;
      chosen = pool.slice().sort((a, b) => b.mtime - a.mtime)[0];
    }

    const rows = chosen.rows ?? readJsonl(chosen.full);
    const { toolCalls, resultText } = parseSubagentTranscript(rows);
    return { childConversationId: chosen.child, toolCalls, resultText };
  } catch {
    return undefined;
  }
}
