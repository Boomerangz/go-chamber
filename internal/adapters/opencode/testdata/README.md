Captured from the installed OpenCode 1.18.34 (2026-10-07).

- `schema-contract.json`: consumed request schemas and response/event fields from authenticated loopback `/doc`. Check with `scripts/opencode-schema-check`; review differences before `--record`.
- `transcript-1.18.34.json`: native exported OpenRouter `google/gemini-2.5-flash` conversation: answer, read/edit, continuation after backend/server restart.
- `transcript-free-1.18.34.json`: the same smoke using `cohere/north-mini-code:free`, including a real edit permission answered through go-chamber. Provider/model IDs are retained to verify actual routing. Costs are zero for this model.

Only the test conversation is exported; project paths are replaced with `/test/project`. No API credentials or provider config are recorded.
