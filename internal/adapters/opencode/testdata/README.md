Recorded from the installed OpenCode 2.0.15 (2026-10-07), model OpenRouter
`cohere/north-mini-code:free` (zero cost), in a disposable git project.

- `schema-contract.json`: consumed paths and schemas from authenticated loopback `/openapi.json`. Check with `scripts/opencode-schema-check`; review differences before `--record`.
- `events-2.0.15.jsonl`: `/api/event` traffic of one session and its subagent: shell permission rejected, write permission approved, a question form answered, a subagent, an interrupted essay, an unavailable model, an interrupted `/review`. The event stream is not in the OpenAPI schema; this file is its reference.
- `messages-2.0.15.json`: the same session's stored messages; `messages-edit-2.0.15.json`: a read/edit/shell session.

Project paths are replaced with `/test/project`. System messages (tool catalogs) and instruction/inbox events are dropped. No API credentials or provider config are recorded.
