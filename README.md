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

Requirements: Node.js ≥ 20.

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

Config resolves in this order (later overrides earlier): defaults → `~/.cursor/langsmith.json` → `./.cursor/langsmith.json` → environment variables (`TRACE_TO_LANGSMITH`, `CURSOR_LANGSMITH_API_KEY` / `LANGSMITH_API_KEY`, `LANGSMITH_ENDPOINT`, `LANGSMITH_PROJECT`, `CURSOR_LANGSMITH_RUNS_ENDPOINTS`, `CURSOR_LANGSMITH_METADATA`, `CURSOR_LANGSMITH_MODEL_PRICING`, `CURSOR_LANGSMITH_DEBUG`).

Tracing only runs when `enabled` (or `TRACE_TO_LANGSMITH=true`) **and** an API key (or replicas) is set.

Verify activity: `tail -f ~/.cursor/langsmith-hook.log`.

### Cost / pricing

Cost shows in LangSmith via two cooperating paths:

1. **Model normalization** — Cursor's model labels (e.g. `claude-4.6-sonnet`) are normalized to canonical provider ids (e.g. `claude-sonnet-4-6`) as `ls_model_name`, so LangSmith's server-side price table can match and price them for free.
2. **Cost attachment** — we also compute `input_cost` / `output_cost` / `total_cost` from a built-in price table and attach them to `usage_metadata`, so cost renders even when LangSmith can't price a Cursor-specific model.

The built-in prices are **list-price estimates** (`src/pricing.ts`). Override or add models via `model_pricing` (USD per 1M tokens) in `langsmith.json`:

```json
{
  "enabled": true,
  "api_key": "lsv2_pt_...",
  "project": "cursor",
  "model_pricing": {
    "gpt-5.5": { "input": 1.25, "output": 10, "cache_read": 0.125 },
    "claude-sonnet-4-6": { "input": 3, "output": 15, "cache_read": 0.3, "cache_creation": 3.75 }
  }
}
```

Keys may be the canonical id or the Cursor label; overrides win over the built-in table.

## What's traced

- **Turns** grouped into threads (`thread_id` = `conversation_id`).
- **Token usage / cost** per turn (`usage_metadata` on the `llm` run; see [Cost / pricing](#cost--pricing)).
- **Model / provider** (`ls_model_name`, `ls_provider`) — Cursor's label, normalized to a canonical provider id. Auto mode reports `default` (provider `cursor`).
- **Tool calls** (success and failure) with inputs/outputs.
- **Subagents** as a `Task` tool run (type + task).

## Known limitations (v1)

- **Image/file attachments** are not traced — Cursor does not expose attachment bytes to hooks.
- **Subagent internals** (their own tool calls and token usage) are not traced — they arrive under a separate conversation with no usage signal. The subagent appears as a single `Task` run.

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
