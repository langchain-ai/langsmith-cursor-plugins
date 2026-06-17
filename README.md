# LangSmith Tracing for Cursor

Traces Cursor agent turns — prompts, model responses, tool calls, token usage, and subagents — to [LangSmith](https://smith.langchain.com), grouped into threads per conversation.

It works via [Cursor hooks](https://cursor.com/docs/agent/hooks): short-lived hook processes buffer the agent's event stream to a local state file, and each `stop` (one per turn) assembles and posts one LangSmith trace.

## How it works

Cursor's transcript file is text-only, so this integration is built entirely from **hook payloads**, not the transcript:

- `beforeSubmitPrompt` opens a turn buffer (prompt + model) — or, for a `/langsmith` command, posts feedback to the previous turn instead (see [Flag a trace with feedback](#flag-a-trace-with-feedback)).
- `postToolUse` / `postToolUseFailure` append tool calls.
- `afterAgentResponse` records the final text + token usage.
- `subagentStart` / `subagentStop` record subagents (linked to the turn).
- `stop` finalizes the turn: builds the trace and flushes it to LangSmith.

Each turn is its own trace, grouped into a thread via `thread_id = conversation_id`:

```
Cursor Turn N (chain)
├── <provider> (llm)   model/provider + token usage, assistant text
├── Read / Shell / … (tool)
└── Task (tool)         subagent (type + task)
```

## Install

Requirements: Node.js ≥ 22.13 (uses the built-in `node:sqlite` module, with its read-only open option, for attachment enrichment).

```bash
pnpm install
pnpm build              # tsc → esbuild → bundle/*.js

# install hooks (writes ~/.cursor/hooks.json by default; merges with existing)
node scripts/install.mjs            # user-global (all projects)
node scripts/install.mjs --project  # project-scoped (./.cursor/hooks.json)
node scripts/install.mjs --print    # preview without writing
```

Then **fully restart Cursor** so it reloads `hooks.json`.

## Configure

Create `~/.cursor/langsmith.json` (global) or `./.cursor/langsmith.json` (project):

```json
{
  "enabled": true,
  "api_key": "lsv2_pt_...",
  "api_url": "https://api.smith.langchain.com",
  "project": "cursor"
}
```

Config resolves in this order (later overrides earlier): defaults → `~/.cursor/langsmith.json` → `./.cursor/langsmith.json` → environment variables.

Every `CURSOR_LANGSMITH_*` variable also accepts the `LANGSMITH_*` form (the `CURSOR_LANGSMITH_*` name wins when both are set).

| Environment variable              | Config key       | Description                                                           | Default                           |
| --------------------------------- | ---------------- | --------------------------------------------------------------------- | --------------------------------- |
| `TRACE_TO_LANGSMITH`              | `enabled`        | Master switch — tracing runs only when truthy.                        | `false`                           |
| `CURSOR_LANGSMITH_API_KEY`        | `api_key`        | LangSmith API key.                                                    | —                                 |
| `CURSOR_LANGSMITH_ENDPOINT`       | `api_url`        | LangSmith API base URL.                                               | `https://api.smith.langchain.com` |
| `CURSOR_LANGSMITH_PROJECT`        | `project`        | Target tracing project.                                               | `cursor`                          |
| `CURSOR_LANGSMITH_METADATA`       | `metadata`       | Extra metadata attached to every run (JSON object).                   | —                                 |
| `CURSOR_LANGSMITH_RUNS_ENDPOINTS` | `replicas`       | Additional replica destinations (JSON array).                         | —                                 |
| `CURSOR_LANGSMITH_ATTACHMENTS`    | `attachments`    | Enrich turns with image/file attachment bytes from Cursor's DB.       | `true`                            |
| `CURSOR_LANGSMITH_DB_PATH`        | `cursor_db_path` | Override the Cursor `state.vscdb` path used for attachments.          | platform default                  |
| `CURSOR_LANGSMITH_DEBUG`          | —                | Verbose hook logging.                                                 | `false`                           |
| `CURSOR_LANGSMITH_STATE_FILE`     | —                | Override the on-disk event-buffer state file (no `LANGSMITH_*` form). | `~/.cursor/langsmith-state.json`  |
| `CURSOR_LANGSMITH_LOG_FILE`       | —                | Override the hook log file (no `LANGSMITH_*` form).                   | `~/.cursor/langsmith-hook.log`    |

Tracing only runs when `enabled` (or `TRACE_TO_LANGSMITH=true`) **and** an API key (or replicas) is set.

Verify activity: `tail -f ~/.cursor/langsmith-hook.log`.

### Cost / pricing

We don't compute cost locally. Instead, Cursor's model labels (e.g. `claude-4.6-sonnet`) are normalized to canonical provider ids (e.g. `claude-sonnet-4-6`) as `ls_model_name`, and the token breakdown is sent as `usage_metadata`. LangSmith's server-side model price table matches the canonical id and renders cost in the UI. Auto mode reports `default` (provider `cursor`), which LangSmith can't price.

## What's traced

- **Turns** grouped into threads (`thread_id` = `conversation_id`).
- **Token usage** per turn (`usage_metadata` on the `llm` run), priced by LangSmith (see [Cost / pricing](#cost--pricing)).
- **Model / provider** (`ls_model_name`, `ls_provider`) — Cursor's label, normalized to a canonical provider id. Auto mode reports `default` (provider `cursor`).
- **Tool calls** (success and failure) with inputs/outputs.
- **Image/file attachments** — recovered from Cursor's local DB and rendered inline on the user message.
- **Subagents** as a `Task` tool run (type + task), with their internal tool calls nested underneath.

## Flag a trace with feedback

You can attach LangSmith feedback to the turn you just saw **without leaving Cursor** — useful for flagging a prompt that burned excessive tokens, gave a bad answer, or worked unusually well, so it can be reviewed (or ingested) later.

Type a `/langsmith` command in the Cursor chat box instead of a normal message. The `beforeSubmitPrompt` hook posts the feedback to the previous turn's trace and **cancels** the submission (it never reaches the agent), echoing a confirmation:

| Command                          | Effect on the previous turn's trace          |
| -------------------------------- | -------------------------------------------- |
| `/langsmith good [comment]`      | 👍 score `1`                                  |
| `/langsmith bad too many tokens` | 👎 score `0` + comment                        |
| `/langsmith flag revisit this`   | 🚩 bookmark (no score) + comment              |
| `/langsmith <free text>`         | 📝 comment-only note                          |
| `/langsmith`                     | shows usage help                             |

`/ls` is an alias. All feedback is recorded under the key `user_feedback`, so it can be filtered by score or comment in LangSmith. Feedback targets the most recently finalized turn in the conversation, so send your message, see the response, then flag it.

## Known limitations

- **Subagent token usage** is not available — Cursor exposes no per-subagent usage breakdown via hooks or its local DB, so a subagent's `Task` run carries its tool calls but no token counts.

## Development

```bash
pnpm build       # compile + bundle
pnpm test        # vitest (unit + replay over captured hook logs)
pnpm format      # oxfmt
pnpm lint        # oxlint
```

`diagnostics/` holds the throwaway hook-capture kit and real captures used as test fixtures.

## License

MIT
