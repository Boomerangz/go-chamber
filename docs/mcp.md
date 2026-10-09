# MCP

go-chamber serves MCP at `/api/mcp` (streamable HTTP). Through it, another agent can start
sessions, give them work, wait for turns, answer their questions and read what they did. It is
authenticated with the same token as the web UI (`~/.go-chamber/token`), sent as
`Authorization: Bearer <token>`.

## Connect

Claude Code:

```sh
claude mcp add --transport http go-chamber http://127.0.0.1:7777/api/mcp \
  --header "Authorization: Bearer $(cat ~/.go-chamber/token)"
```

Codex:

```sh
export GO_CHAMBER_TOKEN=$(cat ~/.go-chamber/token)
codex mcp add go-chamber --url http://127.0.0.1:7777/api/mcp --bearer-token-env-var GO_CHAMBER_TOKEN
```

## Tools

| Tool | What it does |
|---|---|
| `list_sessions` | Sessions with status and open requests; `folder`, `include_archived` filter |
| `start_session` | `agent` in `cwd`, optionally on a new worktree `branch`, with `model`, `effort`, `permission_mode` and a first `message` |
| `send_message` | Starts a turn or adds to the running one; returns `since_seq` |
| `wait` | Blocks until the turn ends (`idle`, `interrupted`), the agent asks (`needs_answer`), or `timeout_seconds` (`running`) |
| `read_session` | Transcript since `since_seq`: messages whole, tools one line each, the tail kept under `max_chars` |
| `answer_request` | Answers a question (`answers`: question text → labels) or a permission (`allow`) |
| `interrupt` | Stops the running turn |
| `get_diff` | Changed files against the base and their diff, of one `path` or all |

The loop is `send_message` → `wait(since_seq)`, repeated with the `seq` each `wait` returns while
it says `running`. A `wait` is capped at 30 minutes. Keep `timeout_seconds` under the client's
own tool timeout. With a progress token, `wait` reports each finished
tool call as a progress notification.

## Resources

- `chamber://sessions`: the session list, JSON.
- `chamber://sessions/{id}`: a session's transcript.
- `chamber://sessions/{id}/diff`: its diff.

All three accept `resources/subscribe`: an update is sent when a turn starts or ends, a request
opens or closes, or an item finishes.

## Safety

- MCP clients can **deny** permission requests but not grant them, so one agent cannot widen
  another's rights. `-mcp-allow-approvals` lifts that.
- Messages and decisions sent over MCP are tagged `via MCP` in the transcript and do not mark the
  session as seen.
- A session that waits on itself is not stopped: its `wait` returns `running` at the timeout.
