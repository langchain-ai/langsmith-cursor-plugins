# LangSmith Tracing for Cursor

Sends your Cursor agent conversations to [LangSmith](https://smith.langchain.com) so you can see what the agent actually did.

## What you need

- **On a Mac:** nothing. The plugin carries its own Apple silicon and Intel builds and picks the right one.
- **On Windows and Linux:** Node.js 22.13 or newer.
- A LangSmith account.

## Install

### Install for yourself

1. Open **Customize** in Cursor and choose **Add Marketplace**.
2. Enter `https://github.com/langchain-ai/langsmith-cursor-plugins`.
3. Run `/add-plugin langsmith-tracing` in the agent chat, or install it from the new **LangChain** tab in **Customize**.
4. Fully restart Cursor so it loads the plugin's hooks.

### Install for your organization

Admins on a Teams or Enterprise plan can install the plugin for everyone by importing this repository as a team marketplace. See [Cursor's plugin docs](https://cursor.com/docs/plugins) for how. Then use the managed file below to switch tracing on and set the project for everyone.

### Lock settings with a managed file

An admin can lock settings with a managed file at `~/.langsmith-plugins/managed.json` in each user's home folder. It overrides every other file and environment variable. Every setting except `profile`, `cursor_db_path` and `sweep_idle_minutes` can be locked. Admins usually install it on each machine with an MDM tool, which manages company laptops (such as Jamf, Kandji or Microsoft Intune).

The managed file works on macOS and Linux, and the plugin only trusts it when:

- Root owns the file and its folder
- No other user can write to either
- Neither is a symlink

If the file is broken or fails these checks then tracing stops. The plugin's log explains why and so does its reply to mute or unmute. See [the settings guide](https://github.com/langchain-ai/langsmith-plugin-binary/blob/main/docs/settings.md) to set it up.

## Authenticate

The simplest option is to sign in once with the LangSmith CLI, which you can [install from its docs](https://docs.langchain.com/langsmith/langsmith-cli#install) if you don't have it yet:

```bash
langsmith auth login
```

If you use the CLI sign-in and have more than one profile set `profile` to the one the plugin should use. API keys ignore this setting.

You can use an API key instead by setting `api_key` in your config file. Create one at [smith.langchain.com](https://smith.langchain.com) under **Settings** then **API Keys**.

If more than one credential is set the plugin uses the first one it finds:

1. The plugin's own key from `api_key` or `LANGSMITH_CURSOR_API_KEY`
2. Your `langsmith auth login` sign-in
3. A generic `LANGSMITH_API_KEY` in your shell

When your sign-in expires or your key is rejected the plugin stops uploading but still lets your prompts through, and turns from that gap are never uploaded. Cursor can't show a message without stopping the prompt, so the reason goes to the plugin's log instead. The log also notes when `api_url` points at a different server than your sign-in, since the sign-in can't be used there.

### Strict auth

Strict auth holds back every prompt with a message until your sign-in or key works again, even if no credentials were ever set. Turn it on by setting `strict_auth` to `true`. It's off by default and has no effect while tracing is off.

## Turn on tracing

Tracing is off until you switch it on in `~/.cursor/langsmith.json`, unless your admin already turned it on with a [managed file](#lock-settings-with-a-managed-file). Send traces to an agent with `agent_id`:

```json
{ "enabled": true, "agent_id": "shared-cursor" }
```

Or send them to a project with `project`:

```json
{ "enabled": true, "project": "shared-cursor" }
```

Use either one, and `agent_id` wins if you set both. With neither set traces go to the `cursor` project. Send a prompt and look for it in LangSmith. You only need `api_url` if you don't use the default LangSmith server.

A project can override these settings in `<project>/.cursor/langsmith.json` or `<project>/langsmith-plugins.json`. You can also share settings across LangSmith plugins in `~/.langsmith-plugins.json`. Project files win over your own files and any environment variable beats them all.

> **Read a repository's tracing config before you trust it.** A cloned repository can switch tracing on and send your prompts and files to someone else's server. Review its `.cursor/langsmith.json` and `langsmith-plugins.json` first. Cursor's own `.cursor/hooks.json` can run commands, so read that one too.

## What gets traced

Each prompt and the agent's work on it becomes one trace, and a conversation's traces are grouped into one LangSmith thread:

```
Cursor Turn N (chain)
├── <provider> (llm)   model, assistant reply and token usage
├── Read / Shell / … (tool)
├── Skill (tool)       one per skill file the agent read
└── Task (tool)        a subagent, with its own tool calls nested underneath
```

Each model call includes the reply along with the model name, provider and token counts. Tool calls include their inputs and outputs, failures included, and skill reads record which skill ran. Subagents appear nested under the turn that started them.

A tool call that touches a file inside a git repo is tagged with the repository name, branch, commit and author. Turns in Auto mode show `default` as the model because Cursor doesn't report which model ran, and subagents show no token counts because Cursor doesn't report usage for them.

## Hide a conversation

Send `langsmith-tracing:mute` as a message in Cursor's agent chat to stop uploading that conversation's content. Send `langsmith-tracing:unmute` to turn it back on. The message must be exactly that text with no slash, or it's traced as a normal prompt.

The acknowledgment appears as a blocked prompt. That's how Cursor shows a plugin's reply, so nothing went wrong and the message never reaches the model.

Wait for the acknowledgment before you send anything private. A muted trace keeps timing, run names, model and tool names and token counts but leaves out prompts, replies, tool results, attachments and errors. Muting follows the conversation across restarts and doesn't change earlier uploads.

Set `defaultMuted` to `true` to mute every new conversation by default. A conversation you mute or unmute by hand keeps that choice.

## When nothing shows up

- **No runs at all.** Check that the plugin is in Cursor's plugin list and that you fully restarted Cursor after installing it. Then check that tracing is on.
- **Tracing is paused.** The log says your sign-in expired or your key was rejected. Run `langsmith auth login` again or replace the key and tracing resumes from the next prompt.
- **Still stuck.** Run `tail -f ~/.cursor/langsmith_hook.log` while you send a prompt. The background uploader logs to `~/.cursor/langsmith_engine/worker.log` and `LANGSMITH_CURSOR_DEBUG=1` adds more detail.
- **Node too old on Windows or Linux.** Cursor starts its hooks from the desktop app, so it can pick up an old system Node instead of the one you manage with nvm, mise or asdf. The log names the Node it used. Make Node 22.13 or newer the one your login shell picks, or start Cursor from a terminal with `cursor .` so it inherits your shell.

## Privacy

With tracing on each turn uploads your prompts, replies, tool inputs and outputs, attachments, metadata and token usage. A muted turn uploads only its structure.

Secrets the plugin recognizes are stripped before upload unless you turn `redact` off. Redaction isn't a guarantee that everything else is safe to share. This only controls what the plugin uploads and not what Cursor or the model provider does with your data.

## Settings

Each setting has a config file key and an environment variable. The environment variable wins when both are set. Every `LANGSMITH_CURSOR_` variable except the API key and default mute also accepts a shorter `LANGSMITH_` name, and the `LANGSMITH_CURSOR_` name wins if you set both.

| Setting              | Environment variable                  | What it does                                | Default                           |
| -------------------- | ------------------------------------- | ------------------------------------------- | --------------------------------- |
| `enabled`            | `TRACE_TO_LANGSMITH`                  | Turns tracing on                            | `false`                           |
| `api_key`            | `LANGSMITH_CURSOR_API_KEY`            | Your LangSmith API key                      | none                              |
| `api_url`            | `LANGSMITH_CURSOR_ENDPOINT`           | Which LangSmith to send to                  | `https://api.smith.langchain.com` |
| `project`            | `LANGSMITH_CURSOR_PROJECT`            | Project the traces land in                  | `cursor`                          |
| `agent_id`           | `LANGSMITH_AGENT_ID`                  | Agent to trace to, instead of project       | none                              |
| `defaultMuted`       | `LANGSMITH_CURSOR_DEFAULT_MUTED`      | Starts every new conversation muted         | `false`                           |
| `redact`             | `LANGSMITH_CURSOR_REDACT`             | Strips detected secrets before upload       | `true`                            |
| `redact_extra_rules` | `LANGSMITH_CURSOR_REDACT_EXTRA`       | Extra patterns to strip                     | none                              |
| `attachments`        | `LANGSMITH_CURSOR_ATTACHMENTS`        | Includes images attached to prompts         | `true`                            |
| `system_prompt`      | `LANGSMITH_CURSOR_SYSTEM_PROMPT`      | Includes the system prompt                  | `true`                            |
| `metadata`           | `LANGSMITH_CURSOR_METADATA`           | Custom fields on every run                  | none                              |
| `replicas`           | `LANGSMITH_CURSOR_RUNS_ENDPOINTS`     | Send the same trace somewhere else too      | none                              |
| `strict_auth`        | `LANGSMITH_CURSOR_STRICT_AUTH`        | Hold back prompts until you sign in again   | `false`                           |
| `cursor_db_path`     | `LANGSMITH_CURSOR_DB_PATH`            | Where Cursor's local database lives         | platform default                  |
| `sweep_idle_minutes` | `LANGSMITH_CURSOR_SWEEP_IDLE_MINUTES` | How long an unfinished turn waits to upload | `360`                             |
| `profile`            | none                                  | Which CLI login to use                      | the CLI's current one             |
| `workspace_id`       | none                                  | Workspace for a login's traces              | the login's own                   |

`profile` is personal so the managed file can't lock it. `LANGSMITH_PROFILE` is only used when no `profile` is set in a settings file.

## Development

```bash
pnpm build
pnpm test
pnpm lint
pnpm format
```

The macOS binary is built, signed and released by the shared pipeline in [langsmith-plugin-binary](https://github.com/langchain-ai/langsmith-plugin-binary) using `binary.config.json`.

## License

MIT
