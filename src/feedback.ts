/**
 * Parse a user-typed feedback slash-command (e.g. "/langsmith good too slow")
 * into LangSmith feedback fields. Pure — no I/O — so fully unit-testable.
 *
 * Grammar: `<prefix> [sentiment] [comment...]`
 *   /langsmith good <comment>   → score 1
 *   /langsmith bad  <comment>   → score 0
 *   /langsmith flag <comment>   → bookmark (value "flagged", no score)
 *   /langsmith <free text>      → comment-only note
 *   /langsmith                  → help
 */

import { FEEDBACK_COMMAND_PREFIXES, FEEDBACK_KEY } from "./constants.js";

/** Recognized feedback to record against a run. */
export interface ParsedFeedback {
  key: string;
  score?: number;
  value?: string;
  comment?: string;
  /** Short human label for the confirmation message, e.g. "👍 good". */
  label: string;
}

/** Result of parsing a prompt: not a command (null), a help request, or feedback. */
export type FeedbackCommand = { kind: "help" } | ({ kind: "feedback" } & ParsedFeedback);

/** Sentiment word → fields. Order matters only for the alias lists. */
const SENTIMENTS: Array<{ words: string[]; label: string; fields: Partial<ParsedFeedback> }> = [
  { words: ["good", "great", "👍", "+1", "up", "yes", "positive"], label: "👍 good", fields: { score: 1 } },
  { words: ["bad", "poor", "👎", "-1", "down", "no", "negative"], label: "👎 bad", fields: { score: 0 } },
  {
    words: ["flag", "bookmark", "revisit", "todo", "star", "⭐", "mark"],
    label: "🚩 flagged",
    fields: { value: "flagged" },
  },
];

/** Strip a leading feedback prefix; returns the remainder, or null if no prefix. */
function stripPrefix(prompt: string): string | null {
  const trimmed = prompt.trim();
  const firstSpace = trimmed.search(/\s/);
  const head = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
  if (!FEEDBACK_COMMAND_PREFIXES.includes(head)) return null;
  return firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
}

/**
 * Parse `prompt`. Returns null when it is not a feedback command (so the normal
 * turn flow proceeds untouched), otherwise a `help` or `feedback` command.
 */
export function parseFeedbackCommand(prompt: string): FeedbackCommand | null {
  const rest = stripPrefix(prompt);
  if (rest === null) return null;
  if (rest.length === 0) return { kind: "help" };

  const spaceIdx = rest.search(/\s/);
  const firstToken = (spaceIdx === -1 ? rest : rest.slice(0, spaceIdx)).toLowerCase();
  const tail = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1).trim();

  const sentiment = SENTIMENTS.find((s) => s.words.includes(firstToken));
  if (sentiment) {
    return {
      kind: "feedback",
      key: FEEDBACK_KEY,
      ...sentiment.fields,
      label: sentiment.label,
      ...(tail ? { comment: tail } : {}),
    };
  }

  // No sentiment keyword → treat the whole remainder as a free-text note.
  return { kind: "feedback", key: FEEDBACK_KEY, label: "📝 note", comment: rest };
}

/** One-line usage help, shown when the user types a bare `/langsmith`. */
export function feedbackHelpText(): string {
  return [
    "LangSmith feedback — flags the trace of your previous turn:",
    "  /langsmith good [comment]   👍 score this turn",
    "  /langsmith bad [comment]    👎 score this turn",
    "  /langsmith flag [comment]   🚩 bookmark to revisit",
    "  /langsmith <note>           📝 attach a comment",
  ].join("\n");
}
