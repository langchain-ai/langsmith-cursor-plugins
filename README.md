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

Create `~/.langsmith-plugins.json` (shared home baseline), `~/.cursor/langsmith.json` (Cursor user), `./langsmith-plugins.json` (shared root project), or `./.cursor/langsmith.json` (Cursor-specific project):

```json
{
  "enabled": true,
  "api_key": "lsv2_pt_...",
  "api_url": "https://api.smith.langchain.com",
  "project": "cursor"
}
```

The shared home filename is `~/.langsmith-plugins.json`; the shared project filename remains `cwd/langsmith-plugins.json`. The old `~/langsmith-plugins.json` is not read as a home baseline (no fallback). If `cwd` is the home directory, that visible file is still read as project config. Root `langsmith.json` is ignored (no backward-compatible alias), even if malformed or containing `enabled: false`. User and project `.cursor/langsmith.json` filenames are unchanged.

### Shared plugin config contract

> **Security: trust repository tracing configuration before using this plugin.** Project `langsmith-plugins.json` and `.cursor/langsmith.json` can enable tracing, choose upload endpoints and replicas, supply credentials, and disable secret redaction. A malicious configuration can send conversation messages, file contents, and tool arguments/outputs to a third party. Review these files before using the plugin in an unfamiliar repository. Also review native `.cursor/hooks.json`: it can run commands. Secret redaction is not a guarantee that uploaded content is safe to share. To prevent this plugin from uploading, disable it.

All four locations accept exactly these common keys (unknown keys are ignored by the common parser):

| Common key           | JSON type        | Default / meaning                                                                                              |
| -------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `enabled`            | boolean          | `false`; master tracing switch                                                                                 |
| `defaultMuted`       | boolean          | `false`; metadata-only default for threads without overrides                                                   |
| `api_key`            | string           | Empty; LangSmith credential                                                                                    |
| `api_url`            | string           | `https://api.smith.langchain.com`                                                                              |
| `project`            | string           | `cursor`                                                                                                       |
| `replicas`           | array of objects | Unset; optional `api_url`, `api_key`, `project` strings and `updates` object per replica                       |
| `metadata`           | object           | Unset; arbitrary user metadata, shallow-merged per key                                                         |
| `redact`             | boolean          | `true`; secret redaction (not the mute switch)                                                                 |
| `redact_extra_rules` | array of objects | Unset; required string `pattern`, optional string `replace`; valid regex, case-sensitive global (`g`) matching |

**Precedence is per field for all common settings, including `enabled` and `defaultMuted`: environment > `cwd/.cursor/langsmith.json` > `cwd/langsmith-plugins.json` > `~/.cursor/langsmith.json` > `~/.langsmith-plugins.json` > defaults.** Missing fields fall through; explicit environment values override even opposing or unhealthy files. Metadata shallow-merges per key in reverse order: **defaults → home root → Cursor user → project root → project Cursor → environment**. Later keys win; nested objects replace rather than recursively merge. An empty metadata object does not clear inherited keys. File metadata, including user-file values that collide with structural keys, remains untrusted custom metadata for muted serialization.

Strings are preserved verbatim, including empty strings. Empty file replica/rule arrays override lower sources. An explicit environment `LANGSMITH_CURSOR_REDACT_EXTRA=[]` (or generic `LANGSMITH_REDACT_EXTRA=[]`) also clears inherited file rules; malformed environment values retain the existing file fallback. File replica aliases `apiUrl`, `apiKey`, `projectName` are accepted; a canonical **own property** wins even when empty, and an invalid canonical value never falls back to its alias. File replicas convert to SDK camelCase at the adapter boundary. Unknown replica/rule keys are stripped; `updates` remains an arbitrary object. Legacy SDK `[projectName, updates]` tuples are environment-only, not valid file replicas.

**Invalid config policy:** a wrong-type present `enabled` restricts only that field to `false`; wrong-type `defaultMuted` restricts only that field to `true`. An invalid recognized ordinary common field (including `redact`, metadata, any replica or regex rule) discards **all common ordinary values in that file** and supplies `enabled: false`, `defaultMuted: true`. Malformed/non-object JSON, unreadable files and nonregular targets (directories/devices/FIFOs) have that same policy. Only a genuinely missing file falls through as absent. **Readable symlinks to regular config files are accepted**; dangling/unreadable links are invalid. Ordinary values may then inherit from lower sources, and explicit higher-priority boolean fields still win. Diagnostics contain fixed messages, not raw values or secrets. This config symlink policy does not change the stricter sticky privacy-file policy below.

The project is the first `workspace_roots` entry when supplied by Cursor, not the hook installation directory. Otherwise the loader uses `CURSOR_PROJECT_DIR`, then the process cwd. Both project files are read only in that directory; ancestors are never searched. The master environment switch `TRACE_TO_LANGSMITH` retains its historical case-insensitive, whitespace-trimming parser: `1`/`true`/`yes`/`on` enable, `0`/`false`/`no`/`off` disable, and unrecognized values leave tracing disabled. `LANGSMITH_CURSOR_DEFAULT_MUTED` accepts case-insensitive `true`/`false` **without trimming**; any other present value means muted. JSON-file `enabled` and `defaultMuted` still require actual booleans, not these environment aliases. Existing credential/enrichment environment aliases and parsers remain separate from file validation.

**Credentials are secrets.** Prefer environment variables or an untracked, permission-restricted user config for API keys; do not commit keys in either project file (including replica keys). Review repository-supplied destinations, credentials, replica updates and redaction settings before enabling tracing: they can route full content elsewhere or disable redaction. `redact: false` never disables metadata-only privacy filtering. Mute does not encrypt local config/state or protect against local file tampering.

### Cursor-only extensions

These are not common keys and are validated separately, per field, in all four files:

| Extension        | JSON type | Default                             |
| ---------------- | --------- | ----------------------------------- |
| `attachments`    | boolean   | `true`; DB attachment enrichment    |
| `system_prompt`  | boolean   | `true`; DB system-prompt enrichment |
| `cursor_db_path` | string    | Platform default DB path            |

Each wrong-type extension is omitted with a fixed diagnostic and falls through to lower sources; it **never disables valid common configuration** or discards another extension. Unknown harness-specific fields (including legacy `step_fidelity`) are ignored. Extensions use environment > project `.cursor` > project root > Cursor user > home root > defaults precedence. They do not override muted enrichment restrictions.

The credential/enrichment variables below also accept the `LANGSMITH_*` form (the `LANGSMITH_CURSOR_*` name wins when both are set). Default mute and the explicit state/privacy/log paths use only their listed harness-specific names.

| Environment variable              | Config key           | Description                                                                                                                             | Default                           |
| --------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `TRACE_TO_LANGSMITH`              | `enabled`            | Master switch; when present, overrides file `enabled` values.                                                                           | `false`                           |
| `LANGSMITH_CURSOR_DEFAULT_MUTED`  | `defaultMuted`       | Default metadata-only tracing for threads without an override; case-insensitive `true`/`false`, invalid values mute (no generic alias). | `false`                           |
| `LANGSMITH_CURSOR_API_KEY`        | `api_key`            | LangSmith API key.                                                                                                                      | —                                 |
| `LANGSMITH_CURSOR_ENDPOINT`       | `api_url`            | LangSmith API base URL.                                                                                                                 | `https://api.smith.langchain.com` |
| `LANGSMITH_CURSOR_PROJECT`        | `project`            | Target tracing project.                                                                                                                 | `cursor`                          |
| `LANGSMITH_CURSOR_METADATA`       | `metadata`           | Extra metadata attached to every run (JSON object).                                                                                     | —                                 |
| `LANGSMITH_CURSOR_RUNS_ENDPOINTS` | `replicas`           | Additional replica destinations (JSON array).                                                                                           | —                                 |
| `LANGSMITH_CURSOR_ATTACHMENTS`    | `attachments`        | Enrich turns with image/file attachment bytes from Cursor's DB.                                                                         | `true`                            |
| `LANGSMITH_CURSOR_SYSTEM_PROMPT`  | `system_prompt`      | Recover the system prompt from Cursor’s DB.                                                                                             | `true`                            |
| `LANGSMITH_CURSOR_DB_PATH`        | `cursor_db_path`     | Override the Cursor `state.vscdb` path used for attachments.                                                                            | platform default                  |
| `LANGSMITH_CURSOR_REDACT`         | `redact`             | Redact detected secrets from traced data before upload.                                                                                 | `true`                            |
| `LANGSMITH_CURSOR_REDACT_EXTRA`   | `redact_extra_rules` | Extra redaction rules: JSON array of `{ pattern, replace }`; each `pattern` is case-sensitive and applied with the `g` flag.            | —                                 |
| `LANGSMITH_CURSOR_DEBUG`          | —                    | Verbose hook logging.                                                                                                                   | `false`                           |
| `LANGSMITH_CURSOR_STATE_FILE`     | —                    | Override the on-disk event-buffer state file (no `LANGSMITH_*` form).                                                                   | `~/.cursor/langsmith-state.json`  |
| `LANGSMITH_CURSOR_LOG_FILE`       | —                    | Override the hook log file (no `LANGSMITH_*` form).                                                                                     | `~/.cursor/langsmith-hook.log`    |

Tracing only runs when the resolved master switch is enabled **and** an API key (or replicas) is set. Thread controls never enable master tracing.

Verify activity: `tail -f ~/.cursor/langsmith-hook.log`.

### Sticky per-thread mute

Send one of these **exact messages**, by itself, in Cursor Agent Chat:

```text
langsmith-tracing:mute
langsmith-tracing:unmute
```

No leading slash, arguments, surrounding whitespace, or additional lines. Other spellings are ordinary prompts, **not privacy controls**. Wait for the local hook acknowledgment before submitting private work. A successful acknowledgment says the preference was saved; a blocked submission reporting failure is **not** a successful mute/unmute.

These are deterministic `beforeSubmitPrompt` command-hook controls, not LLM skills or Markdown slash commands. The hook writes the preference and returns `{"continue":false,"user_message":"…"}` with exit 0: the control is acknowledged locally and is not submitted to the model or recorded as a tracing turn. Controls work even when tracing is off or no API key is configured. We have not verified Cursor UI slash forwarding, so slash-prefixed variants are deliberately unsupported.

- **Default:** threads without overrides trace full content when master tracing is enabled, unless default mute is configured below.
- **Next turn only:** each ordinary prompt snapshots `off`, `full`, or `metadata` into its `generation_id` buffer. Muting/unmuting leaves already active or queued generations unchanged, including tools and nested subagents launched by those turns. Duplicate prompt delivery does not replace an existing snapshot.
- **Sticky:** the preference follows native `conversation_id` across turns and local restarts, independent of workspace paths and the transient buffer’s 24-hour pruning. It does not automatically follow a new/forked conversation ID, another machine, or a cloud VM.
- **Muted traces:** retain topology, structural IDs, run types/names, times, safe status, model name, native tool name, coding-agent schema/integration/runtime versions, and trusted numeric token usage. Every run has `ls_tracing_mode: "metadata"`. Normal message-shaped inputs and outputs contain `[LangSmith system notice: content omitted because tracing is muted.]`.
- **Not sent in muted runs:** prompts, tool arguments/results, assistant text/thoughts, attachments, raw errors, cwd/file/user/repository details, arbitrary custom metadata, tags/events, replica content overrides, or SDK runtime/environment enrichment. Attachment and system-prompt enrichment is skipped. Step decoding and subagent transcript reads may still occur locally to preserve the existing trace structure and joins; the central serialization boundary removes their content.
- **No retroactive changes:** mute does not purge existing LangSmith traces or Cursor history. Unmute never fills in old muted runs. A later full turn may repeat private material in its context or output; this is accepted and there is no content-tracking policy. Use a new conversation if that is unsuitable.

#### Default mute configuration

To start threads in metadata-only mode without a command in each thread:

```bash
export LANGSMITH_CURSOR_DEFAULT_MUTED="true"
# Set "false" to return to the full-content default.
```

Or set JSON booleans in project `.cursor/langsmith.json`, root project `langsmith-plugins.json`, user `~/.cursor/langsmith.json`, or shared home `~/.langsmith-plugins.json`:

```json
{
  "enabled": true,
  "defaultMuted": true
}
```

Credentials are still required. You can omit `enabled` to inherit it from a lower-priority source.

Precedence is **`LANGSMITH_CURSOR_DEFAULT_MUTED` > project `.cursor/langsmith.json` > project `langsmith-plugins.json` > `~/.cursor/langsmith.json` > `~/.langsmith-plugins.json` > false (unmuted)**, independently of `enabled`. An `enabled`-only file does not hide lower-priority default mute; a `defaultMuted`-only file does not hide lower-priority master enablement. Missing fields fall through. Invalid present JSON booleans (strings, null, numbers, etc.) use the restrictive value: `enabled: false`, `defaultMuted: true`. An unhealthy file restricts both fields rather than falling through, unless an explicit higher-priority source overrides them. Environment `true`/`false` are case-insensitive **without whitespace trimming**; any other present default-mute value, including an empty string, means muted. Unset falls through to files, then the unmuted default. The environment variable uses Cursor’s existing `LANGSMITH_CURSOR_` prefix, with no generic alias.

Explicit sticky thread overrides always win: an unmute overrides default mute, and a mute survives changing the default to full. Configuration changes affect the next new generation of threads without overrides, not active/queued turns, duplicate prompts, tools, or saved subagent launch snapshots. Missing launch evidence still falls back to metadata-only, never upgraded by an unmuted config or a later unmute. The existing conservative subagent ownership checks remain unchanged.

Configuration alone owns the fallback default. The strict privacy schema is `{ "threads": { "conversation-id": "metadata" } }`, with only `"full"` or `"metadata"` values and no other top-level fields. Reads never create or modify this file; controls save only an explicit thread override, including while master tracing is off. Removing the privacy file removes overrides and returns to the configured default.

#### State and safe fallback

The durable preferences file is `~/.cursor/langsmith-state.privacy.json`, resolved with Node’s platform-appropriate `os.homedir()`. `LANGSMITH_CURSOR_PRIVACY_FILE` can override it explicitly. It is **independent** of `LANGSMITH_CURSOR_STATE_FILE` (default `~/.cursor/langsmith-state.json`). Changing/deleting the transient buffer does not clear mute. Changing/deleting the privacy file does: an absent privacy file uses the configured default (full when unset). Do not delete it as a troubleshooting shortcut.

Only controls write the shared preference file. Unlike integrations that replay whole transcripts at Stop, Cursor consumes one generation buffer at `stop`; launch evidence belongs in that existing buffer, not in a second unbounded turn-history ledger. A missing launch snapshot is metadata-only; no buffer means no trace. An `off` snapshot never becomes full merely because master tracing is enabled before Stop. Current master-off still suppresses sends.

Malformed, unreadable, or symlinked privacy files cause ordinary enabled turns to snapshot metadata-only. Both controls refuse to overwrite an unhealthy preference file; repair its contents/permissions and retry. Local state remains local data, **not an encrypted store**: muted hook content can be buffered on disk until Stop/pruning, and Cursor keeps its own history. Protect your account and state directories. Structural IDs, model labels and tool names themselves are not anonymized by mute.

Writers use private directory locks (`0700`), retry for up to about 2 seconds with 10–30 ms jitter, and never steal an old lock. Preferences use a `0600` exclusive temporary file, fsync and atomic rename. Rename is the commit point: subsequent directory-durability/cleanup failures are warnings, not claims that the preference was unchanged. A crashed writer’s `.lock` requires manual removal **only after confirming no writer is running**. Turn buffers use the same bounded lock/atomic-write discipline; a prompt whose snapshot cannot be saved is blocked.

#### Cursor support and trust

The [current official hooks reference](https://cursor.com/docs/hooks#reference) defines `conversation_id` as stable across many turns and `generation_id` as changing with every user message. It documents `beforeSubmitPrompt` as running before the backend request, with enforced `continue` and a `user_message` shown when blocked. By contrast, `sessionStart` is fire-and-forget and does not enforce blocking; it is intentionally not used for controls. The installed prompt hook uses `failClosed: true` and a 15-second timeout.

Use an up-to-date **Cursor desktop Agent Chat**, a trusted workspace, and Node ≥22.13. This implementation has automated registered/bundled hook-contract and real-SDK wire tests, **not a live Cursor UI verification or an established minimum Cursor version**. Older builds, CLI surfaces with missing hooks, read-only cloud exploratory turns, disabled/untrusted hooks, or conflicting higher-priority hooks can invalidate interception. The official docs describe cloud hooks only once a writable environment is available; local user preferences are not available there. Verify a visible successful acknowledgment in your actual client before relying on mute. If unsupported, disable master tracing explicitly and do not send private work assuming a control was intercepted.

Existing subagent transcript/temporal joins and Stop completion behavior are unchanged: ambiguous or missing hook events can still misattribute or omit runs, and Stop removes its buffer before upload (an upload failure can lose that trace). Orphan runs without launch evidence fall back to metadata-only rather than guessing full.

This controls only this plugin’s LangSmith uploads, not Cursor/model-provider data handling, other plugins, arbitrary hooks, logs, or already uploaded history. Config files, hook payload structural fields, installed SDK/code and local filesystem ownership are trusted; this is not protection against another process that can rewrite those files.

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

**Always present** (every run): `ls_agent_purpose` (`"coding"`), `ls_agent_type` (`"root"` or `"subagent"` based on the owning agent), `ls_integration` (`"cursor"`), `ls_agent_runtime` (`"Cursor"`), `ls_trace_schema_version` (`"coding-agent-v1"`), `thread_id` (= `conversation_id`).

**Present where known** (every run): `ls_integration_version` (plugin version, build-time injected), `ls_agent_runtime_version` (Cursor's `cursor_version`), `turn_id` (= `generation_id`), `turn_number`, `repository_url` / `repository_provider` / `repository_name`, `git_branch`, `git_commit_sha`, `cwd`.

**Contextual:** `local_username`, `user_email` (provisional). On **subagent** runs only: `ls_subagent_id`, `ls_subagent_type`. On **tool** runs only: `ls_tool_name` (emitted only when the run name differs from the native tool name). `ls_provider` / `ls_model_name` / `ls_invocation_params` / `usage_metadata` remain on model/tool runs as before.

`user_id`, `sandbox_type`, and `approval_policy` are omitted — Cursor's hooks expose no stable source for them.

## Troubleshooting

**Nothing shows up in LangSmith / `turn_count` stays 0.** Cursor launches hooks from a GUI context, where the `node` on `PATH` is often older than your shell's version-managed node (nvm/mise/asdf). The hook guard resolves Node through your interactive login shell and hands execution to it. The hooks need **Node ≥ 22.13** (for `node:sqlite`).

The hooks run through a small version guard that fails loudly instead of silently. If your node is too old, you'll see a line in `~/.cursor/langsmith-hook.log` (and hook stderr) like:

```
[langsmith] Node 20.11.0 at /usr/local/bin/node is too old for tracing (need >= 22.13 for node:sqlite). This turn was NOT traced. ...
```

The path in that message is the exact node the guard ultimately used. To fix it, configure Node ≥ 22.13 in your login shell's startup files. If those files cannot be used non-manually, install Node ≥ 22.13 in a GUI-visible location or launch Cursor from a terminal (`cursor .`) so it inherits your shell environment.

When tracing is enabled and credentials are configured, the guard also posts that message to your LangSmith project as a `Cursor Tracing Unavailable` error run. Only the prompt hook reports, so you get one run per blocked prompt and not one per hook. It carries the Node version and the node path, but no prompt or response content.

Tail the log to confirm activity: `tail -f ~/.cursor/langsmith-hook.log`.

## Known limitations

- **Subagent token usage** is not available — Cursor exposes no per-subagent usage breakdown via hooks or its local DB, so a subagent's `Task` run carries its tool calls but no token counts.

## Development

```bash
pnpm build       # compile + bundle
pnpm test        # vitest (unit + replay over captured hook logs)
pnpm format      # oxfmt
pnpm lint        # oxlint
```

`test/fixtures/` holds captured hook logs and agent transcripts used as replay test fixtures. `test/shared-config.test.ts` is the canonical shared-contract fixture suite (only its import path differs). `test/privacy.integration.test.ts` exercises project and home root config through real prompt snapshots, stop reduction, builders and SDK wire serialization, including routing/auth, replicas, file regex rules and muted adversarial metadata. `test/config.test.ts` covers per-field privacy precedence (env > project `.cursor/langsmith.json` > project `langsmith-plugins.json` > Cursor user > home root > defaults), restrictive file handling, cwd selection, and env-first credential/enrichment overlays. `test/prompt-control.test.ts` exercises workspace-root config through the registered bundles; rebuild before running it after source changes.

## License

MIT
