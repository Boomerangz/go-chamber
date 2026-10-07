# OpenCode

OpenCode is a third agent alongside Claude Code and Codex. Install OpenCode 2
on the backend's PATH, connect providers with `opencode auth login`, and configure
custom API endpoints, keys, MCP servers, permission rules and the default internal
agent in OpenCode's normal configuration (`opencode.json` / `opencode.jsonc`).
Secrets are never sent to the browser or stored in go-chamber's database.

The sidebar reports CLI availability and the providers that have enabled models.
Choose OpenCode and a working directory, then pick a model in the chat header. The
catalog uses that project's config, groups models by provider ID, supports search
and explicit refresh. The complete `providerID/modelID` is stored, including slashes
inside a model ID. Variant is OpenCode's native model variant. The selection sticks
to the native session, so go-chamber sends it before the next message only when it
changes; choosing the default model selects the configured default again.
Image attachments are available only when the selected/default model advertises
image input. Native slash commands, terminals and worktree sessions are supported.

Permissions can be allowed once, allowed for the session, or denied. Questions
arrive as native forms: string fields with options, multiselect, boolean (Yes/No)
and number fields; custom text when permitted; skipping cancels the form. Hidden
and external (URL) fields are not shown.
Session grants are scoped to the native session ID in the managed server lifetime.
The adapter replies `once` to OpenCode and applies those grants to later matching
requests itself: native `always` can affect sibling sessions or save project rules.
A backend/server restart requires approval again. OpenCode
agent-specific permission rules can override the general permission rules. For
example, to test an edit approval, set `agent.build.permission.edit` to `ask` in
the test project's native config if `build` globally allows all tools.

One lazy, managed `opencode serve` serves all native sessions on a random loopback
port protected by a random HTTP Basic password. The adapter uses the v2 `/api`
surface: a session is created in its project directory, catalog requests pass
`location[directory]`. Native session IDs survive restart; forks copy the native
conversation. Child sessions attach passively and can be stopped with interrupt.
SSE gaps are reconciled against paged history, usage, the active list, pending
permissions/forms and children. The end of an execution (succeeded, failed or
interrupted) ends the turn. A server crash interrupts active turns; a prompt is
never automatically submitted again. Continuing explicitly reuses the native
session. Stopping a turn sends OpenCode interrupt.

The consumed protocol baseline is **2.0.15**; OpenCode 1.x is not supported. After
updating the CLI, run `scripts/opencode-schema-check`, review changes and refresh
the recorded fixtures before using `--record`. The schema covers HTTP only: the v2
event stream is undocumented, so `testdata/events-*.jsonl` is its reference. `make check` includes adapter tests and desktop/mobile E2E
against `testutil/fakeopencode`; provider calls are not part of automated tests.

Initial support covers conversations created by go-chamber and their children.
Importing existing OpenCode conversations, ACP, external servers, entering keys in
the UI and a build/plan selector are deferred.

## Recorded protocol (2026-10-07)

OpenCode 2.0.15, OpenRouter `cohere/north-mini-code:free`, disposable git project:
read/edit, shell, a rejected and an approved permission, a question form, a
subagent, two interrupts and an unavailable model. `testdata` keeps the session
events and stored messages with sanitized paths; system messages are dropped.

## Earlier smoke on 1.18.34 (2026-10-07)

Separate backend and native server, with a disposable project and data directory:

- OpenCode 1.18.34, OpenRouter `google/gemini-2.5-flash`: answer, read/edit and
  context continuation after backend/server restart. Native export confirms both
  provider and model. A 32,000-token default initially exceeded the available
  credits; a test-project model output limit of 512 allowed the bounded smoke.
- OpenRouter **`cohere/north-mini-code:free`**: answer, reading and editing the test
  file, a real edit permission answered once through go-chamber, and continuation
  after restart. Native export confirms the requested provider/model; cost is zero.

The primary running go-chamber and the main checkout were untouched.
