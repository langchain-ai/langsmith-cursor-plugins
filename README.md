# LangSmith Tracing for Cursor

Traces Cursor agent turns — prompts, model responses, tool calls, token usage, and subagents — to [LangSmith](https://smith.langchain.com), grouped into threads per conversation.

It works via [Cursor hooks](https://cursor.com/docs/agent/hooks): short-lived hook processes buffer the agent's event stream to a local state file, and each `stop` (one per turn) assembles and posts one LangSmith trace.

## How it works

Cursor's transcript file is text-only, so this integration is built entirely from **hook payloads**, not the transcript:

- `beforeSubmitPrompt` opens a turn buffer (prompt + model).
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

The recommended way to install is directly from this GitHub repo in Cursor's settings — **Settings → Plugins → add via repo URL** (`https://github.com/langchain-ai/langsmith-cursor-plugins`). It's one step, requires no clone or build (the precompiled `bundle/` is committed), and is how most users should adopt this.

Then **fully restart Cursor** so it reloads `hooks.json`.

<details>
<summary>Local / dev install (clone + script)</summary>

For local development, or to install the hooks from a checkout, clone the repo and run the installer:

```bash
# install hooks (writes ~/.cursor/hooks.json by default; merges with existing)
node scripts/install.mjs            # user-global (all projects)
node scripts/install.mjs --project  # project-scoped (./.cursor/hooks.json)
node scripts/install.mjs --print    # preview without writing
```

The committed `bundle/` means this runs without a build step. Rebuild only after editing the TypeScript source:

```bash
pnpm install
pnpm build              # tsc → esbuild → bundle/*.js
```

Then **fully restart Cursor** so it reloads `hooks.json`.

</details>

> `bundle/` is committed on purpose — it lets the plugin install (via `.cursor-plugin/`) and the local installer run without a build step. Don't add it to `.gitignore`.

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

Every `LANGSMITH_CURSOR_*` variable also accepts the `LANGSMITH_*` form (the `LANGSMITH_CURSOR_*` name wins when both are set).

| Environment variable              | Config key       | Description                                                           | Default                           |
| --------------------------------- | ---------------- | --------------------------------------------------------------------- | --------------------------------- |
| `TRACE_TO_LANGSMITH`              | `enabled`        | Master switch — tracing runs only when truthy.                        | `false`                           |
| `LANGSMITH_CURSOR_API_KEY`        | `api_key`        | LangSmith API key.                                                    | —                                 |
| `LANGSMITH_CURSOR_ENDPOINT`       | `api_url`        | LangSmith API base URL.                                               | `https://api.smith.langchain.com` |
| `LANGSMITH_CURSOR_PROJECT`        | `project`        | Target tracing project.                                               | `cursor`                          |
| `LANGSMITH_CURSOR_METADATA`       | `metadata`       | Extra metadata attached to every run (JSON object).                   | —                                 |
| `LANGSMITH_CURSOR_RUNS_ENDPOINTS` | `replicas`       | Additional replica destinations (JSON array).                         | —                                 |
| `LANGSMITH_CURSOR_ATTACHMENTS`    | `attachments`    | Enrich turns with image/file attachment bytes from Cursor's DB.       | `true`                            |
| `LANGSMITH_CURSOR_DB_PATH`        | `cursor_db_path` | Override the Cursor `state.vscdb` path used for attachments.          | platform default                  |
| `LANGSMITH_CURSOR_REDACT`         | `redact`         | Redact detected secrets from traced data before upload.              | `true`                            |
| `LANGSMITH_CURSOR_REDACT_EXTRA`   | —                | Extra redaction rules: JSON array of `{ pattern, replace }`.          | —                                 |
| `LANGSMITH_CURSOR_DEBUG`          | —                | Verbose hook logging.                                                 | `false`                           |
| `LANGSMITH_CURSOR_STATE_FILE`     | —                | Override the on-disk event-buffer state file (no `LANGSMITH_*` form). | `~/.cursor/langsmith-state.json`  |
| `LANGSMITH_CURSOR_LOG_FILE`       | —                | Override the hook log file (no `LANGSMITH_*` form).                   | `~/.cursor/langsmith-hook.log`    |

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
- **Subagents** as a nested chain run (subagent type + task), with their internal tool calls nested underneath.

## Trace metadata (coding-agent-v1)

Every run carries the shared [`coding-agent-v1`](https://github.com/langchain-ai/langsmith) coding-agent metadata contract on `run.extra.metadata`, built by one helper (`src/metadata.ts`) and propagated to child runs. This lets traces from any coding agent (Claude Code, Codex, Cursor, …) be identified, grouped, and attributed with the same stable keys.

**Always present** (every run): `ls_agent_kind` (`"coding_agent"`), `ls_integration` (`"cursor"`), `ls_agent_runtime` (`"Cursor"`), `ls_trace_schema_version` (`"coding-agent-v1"`), `thread_id` (= `conversation_id`).

**Present where known** (every run): `ls_integration_version` (plugin version, build-time injected), `ls_agent_runtime_version` (Cursor's `cursor_version`), `turn_id` (= `generation_id`), `turn_number`, `repository_url` / `repository_provider` / `repository_name`, `git_branch`, `git_commit_sha`, `cwd`.

**Contextual:** `local_username`, `user_email` (provisional). On **subagent** runs only: `ls_subagent_id`, `ls_subagent_type`. On **tool** runs only: `ls_tool_name` (emitted only when the run name differs from the native tool name). `ls_provider` / `ls_model_name` / `ls_invocation_params` / `usage_metadata` remain on model/tool runs as before.

`user_id`, `sandbox_type`, and `approval_policy` are omitted — Cursor's hooks expose no stable source for them.

## Known limitations

- **Subagent token usage** is not available — Cursor exposes no per-subagent usage breakdown via hooks or its local DB, so a subagent's `Task` run carries its tool calls but no token counts.

## Development

```bash
pnpm build       # compile + bundle
pnpm test        # vitest (unit + replay over captured hook logs)
pnpm format      # oxfmt
pnpm lint        # oxlint
```

`test/fixtures/` holds captured hook logs and agent transcripts used as replay test fixtures.

## License

MIT
