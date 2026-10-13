# LangSmith Tracing for Cursor

Sends your Cursor agent turns to [LangSmith](https://smith.langchain.com) so you can read back what the agent actually did.

## What you need

- **On a Mac, nothing.** The plugin carries its own build and runs it directly.
- **Everywhere else, including Windows,** Node.js 22.13 or newer.
- A LangSmith account and API key.

If the carried Mac build cannot start, the plugin hands the turn to Node instead of losing it, so Node is still worth having.

## Install

Open **Customize** in the sidebar, choose **Browse Marketplace**, click **+**, then **Import from GitHub**, and paste:

```text
https://github.com/langchain-ai/langsmith-cursor-plugins
```

Leave **Scope** on **User** so it installs just for you, then install the plugin and restart Cursor fully so it reloads its hooks.

An admin can instead add the same URL for a whole team from the Cursor web dashboard, under **Plugins & MCPs** then **Team Marketplaces**, and everyone installs it from **Customize**.

## Turn on tracing

Tracing is off until you give it a key and switch it on. Write both to `~/.cursor/langsmith.json`:

```json
{ "enabled": true, "api_key": "lsv2_pt_...", "project": "cursor" }
```

Get a key from [smith.langchain.com](https://smith.langchain.com) under **Settings** then **API Keys**. Send a prompt, then look for it in the `cursor` project.

Settings can also live in a project, at `<project>/.cursor/langsmith.json` or `<project>/langsmith-plugins.json`, or across every harness at `~/.langsmith-plugins.json`. A setting from your shell beats a project file, which beats a user file, which beats the shared one.

> **Check a repository's tracing settings before you trust it.** A project file can switch tracing on, point uploads at someone else's server, supply its own credentials and turn secret redaction off, and a full trace can carry your conversation, file contents and tool results. Review these files in an unfamiliar repository, along with `.cursor/hooks.json`, which can run commands.

## What gets traced

Each prompt becomes one turn, and the turns in a conversation are grouped into a single LangSmith thread. A turn carries the model's reply and token counts, every tool call with its inputs and outputs including the ones that failed, and any subagent with its own tool calls nested underneath. Images and files you attach are recovered from Cursor's local database and shown on your message.

LangSmith works out the cost from the token counts, though a turn run in Auto mode reports no real model so it cannot be priced, and Cursor reports no token usage for subagents.

## Hide one conversation

Send either of these as an ordinary message, with no leading slash and nothing else on the line:

```text
langsmith-tracing:mute
```

```text
langsmith-tracing:unmute
```

Muting keeps tracing the shape of the conversation while leaving the content out, and it applies from the next turn rather than the one in flight. Wait for the confirmation before sending anything sensitive, and if none appears do not assume it worked.

Muting changes only what reaches LangSmith. Cursor still reads and remembers everything locally, and earlier uploads are not deleted. The setting follows the conversation across restarts but does not carry to a fork of it or to another machine.

To mute by default instead of conversation by conversation, set `defaultMuted` to `true`. A conversation you muted or unmuted by hand keeps that choice regardless.

## Settings

Every setting has a config key and an environment variable. The `LANGSMITH_CURSOR_` form wins over the plain `LANGSMITH_` one.

| Config key           | Environment variable              | Default                           | What it does                            |
| -------------------- | --------------------------------- | --------------------------------- | --------------------------------------- |
| `enabled`            | `TRACE_TO_LANGSMITH`              | `false`                           | Whether to trace at all                 |
| `api_key`            | `LANGSMITH_CURSOR_API_KEY`        | none                              | Your LangSmith key                      |
| `project`            | `LANGSMITH_CURSOR_PROJECT`        | `cursor`                          | Where runs land                         |
| `api_url`            | `LANGSMITH_CURSOR_ENDPOINT`       | `https://api.smith.langchain.com` | Which server to send to                 |
| `defaultMuted`       | `LANGSMITH_CURSOR_DEFAULT_MUTED`  | `false`                           | Leave content out unless told otherwise |
| `redact`             | `LANGSMITH_CURSOR_REDACT`         | `true`                            | Strip secrets before upload             |
| `redact_extra_rules` | `LANGSMITH_CURSOR_REDACT_EXTRA`   | none                              | Extra patterns to strip                 |
| `attachments`        | `LANGSMITH_CURSOR_ATTACHMENTS`    | `true`                            | Include attached images and files       |
| `system_prompt`      | `LANGSMITH_CURSOR_SYSTEM_PROMPT`  | `true`                            | Include the system prompt               |
| `metadata`           | `LANGSMITH_CURSOR_METADATA`       | none                              | Custom fields on every run              |
| `replicas`           | `LANGSMITH_CURSOR_RUNS_ENDPOINTS` | none                              | Send the same trace somewhere else too  |

Secrets are stripped before anything is uploaded, covering API keys, JWTs, PEM blocks and common `NAME=value`, `Authorization` and URL-credential shapes. That is not a guarantee that what you upload is safe to share.

## When nothing shows up

Watch the log while you send a prompt:

```bash
tail -f ~/.cursor/langsmith-hook.log
```

- **No runs at all.** Check tracing is switched on and the key is set. A `TRACE_TO_LANGSMITH` in your shell overrides whatever the files say.
- **A line about Node being too old.** Cursor starts its hooks from the desktop app rather than your terminal, so it often finds an old system Node instead of the one you manage with nvm or mise. Make 22.13 or newer the version your login shell picks, or start Cursor with `cursor .` from a terminal.
- **Runs in the wrong place.** Set `LANGSMITH_CURSOR_PROJECT`, or the `project` key.

## What leaves your machine

With tracing on, a full turn uploads your prompts, the replies, tool inputs and outputs, attachments, metadata and token usage. A muted turn uploads the structure and placeholders instead. Keep tracing off if none of that may leave your machine.

## Development

```bash
pnpm install
pnpm test
pnpm lint
pnpm build
```

The macOS build is compiled, signed and released by the shared pipeline in [langsmith-plugin-binary](https://github.com/langchain-ai/langsmith-plugin-binary), driven by `binary.config.json`.

## License

MIT
