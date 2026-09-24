# LangSmith Tracing for Cursor

Sends what Cursor's agent does to [LangSmith](https://smith.langchain.com) so you can read back the prompt, the reply, every tool call and the token usage. A turn is one prompt plus everything the agent does in response, and the turns in one conversation are grouped into a single LangSmith thread.

## What you get

Each turn becomes one trace:

```
Cursor Turn N (chain)
├── <provider> (llm)   model, assistant reply and token usage
├── Read / Shell / … (tool)
├── Skill (tool)       one per skill file the agent read
└── Task (tool)        a subagent, with its own tool calls nested underneath
```

Tool calls carry their inputs and outputs, failures included, and images or files you attached to a prompt are recovered from Cursor's local database and shown inline on your message. Token usage is recorded per turn and LangSmith works the cost out for you, though a turn run in Auto mode reports no real model so it cannot be priced. A subagent's `Task` run shows its tool calls without token counts since Cursor reports no usage for subagents.

Every run also carries the shared `coding-agent-v1` metadata keys, so Cursor traces can be filtered and grouped the same way as traces from any other coding agent.

## Install

### From Cursor

Open **Settings**, then **Plugins**, then add this repository by URL:

```
https://github.com/langchain-ai/langsmith-cursor-plugins
```

Fully restart Cursor afterwards so it reloads its hooks. This is the supported path on every platform and it needs Node.js 22.13 or newer on your machine, since the hooks do not run on anything older.

<details>
<summary>Standalone binary (macOS only, no Node needed)</summary>

The same integration delivered as one file that carries its own JavaScript runtime so it needs no Node on your PATH.

```bash
curl -LsSf https://langch.in/cursor-tracing | bash
```

It lands in `~/.langsmith/langsmith-cursor-tracing` and registers the same eight hooks in `~/.cursor/hooks.json`, and since it never updates itself run `~/.langsmith/langsmith-cursor-tracing --update` when you want a newer release. Remove the plugin first or both it and the binary trace every turn. Only macOS arm64 and x64 are built and the installer picks whichever matches your Mac, so use the plugin above everywhere else. Fully restart Cursor when it finishes.

</details>

<details>
<summary>From a clone</summary>

```bash
node scripts/install.mjs            # every project
node scripts/install.mjs --project  # this project only
node scripts/install.mjs --print    # show what it would write, without writing
```

This merges into any Cursor hooks file you already have. Fully restart Cursor afterwards.

</details>

## Configure

Tracing stays off until you turn it on and give it a LangSmith API key. Put both in `~/.cursor/langsmith.json`:

```json
{
  "enabled": true,
  "api_key": "lsv2_pt_...",
  "project": "cursor"
}
```

That is all most people need. Traces land in the LangSmith project you name, and you only need `api_url` if your LangSmith is not the default `https://api.smith.langchain.com`.

Three other files work the same way, and when more than one of them sets a field the first of these wins: `./.cursor/langsmith.json`, then `./langsmith-plugins.json`, then `~/.cursor/langsmith.json`, then `~/.langsmith-plugins.json`. The two project files are read only in the project Cursor has open and never in a parent directory, and any environment variable below beats all four.

> **Read a repository's tracing config before you trust it.** A `langsmith-plugins.json` or `.cursor/langsmith.json` that ships with a repository can switch tracing on, point it at someone else's endpoint, supply their credentials and turn redaction off, which would send your prompts, file contents and tool output to them. Cursor's own `.cursor/hooks.json` can run commands, so read that one too. Keep your API key in an environment variable or a config file of your own rather than committing it.

| Setting         | Environment variable             | What it does                          | Default                           |
| --------------- | -------------------------------- | ------------------------------------- | --------------------------------- |
| `enabled`       | `TRACE_TO_LANGSMITH`             | Turns tracing on                      | `false`                           |
| `api_key`       | `LANGSMITH_CURSOR_API_KEY`       | Your LangSmith API key                | none                              |
| `api_url`       | `LANGSMITH_CURSOR_ENDPOINT`      | Which LangSmith to send to            | `https://api.smith.langchain.com` |
| `project`       | `LANGSMITH_CURSOR_PROJECT`       | Project the traces land in            | `cursor`                          |
| `defaultMuted`  | `LANGSMITH_CURSOR_DEFAULT_MUTED` | Starts every new conversation muted   | `false`                           |
| `redact`        | `LANGSMITH_CURSOR_REDACT`        | Strips detected secrets before upload | `true`                            |
| `attachments`   | `LANGSMITH_CURSOR_ATTACHMENTS`   | Includes attached images and files    | `true`                            |
| `system_prompt` | `LANGSMITH_CURSOR_SYSTEM_PROMPT` | Includes the system prompt            | `true`                            |

Nothing is uploaded until tracing is on and a key is set. Redaction removes the secrets it recognizes, which is not a promise that everything else it uploads is safe to share.

Rarer settings cover extra metadata on every run (`metadata`), sending to more than one LangSmith (`replicas`), redaction patterns of your own (`redact_extra_rules`), a different Cursor database path (`cursor_db_path`) and how long an unfinished turn waits before it is swept up (`sweep_idle_minutes`). Their environment variables are `LANGSMITH_CURSOR_METADATA`, `LANGSMITH_CURSOR_RUNS_ENDPOINTS`, `LANGSMITH_CURSOR_REDACT_EXTRA`, `LANGSMITH_CURSOR_DB_PATH` and `LANGSMITH_CURSOR_SWEEP_IDLE_MINUTES`, and `LANGSMITH_CURSOR_DEBUG=1` turns on verbose logging. The credential and enrichment variables also answer to the shorter `LANGSMITH_` name, and the `LANGSMITH_CURSOR_` one wins when you set both.

### Muting a conversation

Send `langsmith-tracing:mute` on its own as a whole message in Cursor's agent chat and that conversation stops uploading content, and `langsmith-tracing:unmute` turns it back on. The message has to be exactly that with no slash, no arguments and nothing else around it, since anything else counts as an ordinary prompt and gets traced. Wait for the acknowledgment before you send private work, because a reply reporting failure means the change did not take.

A muted trace keeps only its shape, so times, run names, the model name, native tool names and token counts still go up while prompts, replies, tool arguments and results, attachments and error text do not. The setting follows the conversation across restarts and leaves turns already in flight alone, and it changes nothing that was uploaded earlier. It does not carry over to a fork of the conversation or to another machine. Set `defaultMuted` to start every new conversation muted, and an explicit mute or unmute in a conversation always beats that default.

This controls only what this integration uploads, not what Cursor or the model provider does with your data.

## Checking it works

Watch the log while you send a prompt:

```bash
tail -f ~/.cursor/langsmith-hook.log
```

**Nothing shows up in LangSmith.** Cursor starts its hooks from the desktop app rather than from your terminal, so the `node` it finds is often an old system one instead of the version you manage with nvm, mise or asdf. The hooks work out which Node your login shell would use and re-run themselves under it, and when even that one is too old they say so in the log:

```
[langsmith] Node 20.11.0 at /usr/local/bin/node is too old for tracing (need >= 22.13 for node:sqlite). This turn was NOT traced. ...
```

The path in that line is the Node that was actually used. Fix it by making Node 22.13 or newer the one your login shell picks, or by launching Cursor from a terminal with `cursor .` so it inherits your shell, or by installing the standalone binary above which brings its own runtime.

## Development

```bash
pnpm build
pnpm test
pnpm lint
pnpm format
```

The macOS binary is built, signed and released by the shared pipeline in [langsmith-plugin-binary](https://github.com/langchain-ai/langsmith-plugin-binary), driven by `binary.config.json`.

## License

MIT
