# OpenCode

OpenCode is a third agent alongside Claude Code and Codex. Install `opencode-ai`
on the backend's PATH, connect providers with `opencode auth login`, and configure
custom API endpoints, keys, MCP servers, permission rules and the default internal
agent in OpenCode's normal configuration (`opencode.json` / `opencode.jsonc`).
Secrets are never sent to the browser or stored in go-chamber's database.

The sidebar reports CLI availability and connected providers. Choose OpenCode and
a working directory, then pick a model in the chat header. The catalog uses that
project's config, groups connected providers, supports search and explicit refresh.
The complete `providerID/modelID` is stored, including slashes inside a model ID.
Variant is OpenCode's native model variant; a change applies to the next message.
Image attachments are available only when the selected/default model advertises
image input. Native slash commands, terminals and worktree sessions are supported.

Permissions can be allowed once, allowed for the session, or denied; questions
support single/multiple options, custom text when permitted and skipping.
Session grants are scoped to the native session ID in the managed server lifetime.
The adapter replies `once` to OpenCode and applies those grants to later matching
requests itself: native `always` can affect sibling sessions or save project rules.
A backend/server restart requires approval again. OpenCode
agent-specific permission rules can override the general permission rules. For
example, to test an edit approval, set `agent.build.permission.edit` to `ask` in
the test project's native config if `build` globally allows all tools.

One lazy, managed `opencode serve` serves all native sessions on a random loopback
port protected by a random HTTP Basic password. Every project-scoped request
includes its directory. Native session IDs survive restart; forks copy the native
conversation. Child sessions attach passively and can be stopped with abort.
SSE gaps are reconciled against messages, status, pending permissions/questions
and children. Idle ends the turn. A server crash interrupts active turns; a prompt
is never automatically submitted again. Continuing explicitly reuses the native
session. Stopping a turn sends OpenCode abort.

The consumed protocol baseline is **1.18.34**. After updating the CLI, run
`scripts/opencode-schema-check`, review changes and refresh real transcript fixtures
before using `--record`. `make check` includes adapter tests and desktop/mobile E2E
against `testutil/fakeopencode`; provider calls are not part of automated tests.

Initial support covers conversations created by go-chamber and their children.
Importing existing OpenCode conversations, ACP, external servers, entering keys in
the UI and a build/plan selector are deferred.

## Verified smoke (2026-10-07)

Separate backend and native server, with a disposable project and data directory:

- OpenCode 1.18.34, OpenRouter `google/gemini-2.5-flash`: answer, read/edit and
  context continuation after backend/server restart. Native export confirms both
  provider and model. A 32,000-token default initially exceeded the available
  credits; a test-project model output limit of 512 allowed the bounded smoke.
- OpenRouter **`cohere/north-mini-code:free`**: answer, reading and editing the test
  file, a real edit permission answered once through go-chamber, and continuation
  after restart. Native export confirms the requested provider/model; cost is zero.
- Exported fixtures contain only these test conversations and sanitized project paths.

The primary running go-chamber and the main checkout were untouched.
