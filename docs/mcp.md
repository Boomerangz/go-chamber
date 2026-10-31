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

### Remote MCP clients (OAuth)

A remote MCP client connects to `https://<host>/api/mcp` with OAuth. go-chamber is a
single-owner authorization server: the owner signs in to the usual web UI and explicitly
allows each link on `/oauth/authorize`. Client ID Metadata Documents (CIMD) on public HTTPS
hosts and dynamic client registration (DCR) are supported. Redirect URIs must be HTTPS or
HTTP on `localhost`, `127.0.0.1`, or `[::1]` with an explicit port, and must match the client
metadata or registration exactly. The metadata fetch refuses private/reserved IP addresses,
does not use a proxy or follow redirects, and pins the validated DNS result when connecting.

Hermes Agent, for example, can connect with:

```sh
hermes mcp add go-chamber --url https://<host>/api/mcp --auth oauth
```

An OAuth code uses PKCE (S256). Access tokens last an hour; refresh tokens last 90 days and
rotate. Both are stored as hashes in the database and survive restarts. Dynamically registered
client IDs live in memory: a restart may require a new authorization for a half-done link.
The tokens open `/api/mcp` and nothing else. The public origin follows each request (`Host`,
`X-Forwarded-Proto`, `X-Forwarded-Host`); `-public-url https://host` fixes it when a proxy rewrites
them. In ChatGPT: Settings → Apps & Connectors (developer mode) → create a connector with
`https://<host>/api/mcp` and OAuth.

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
| `run_command` | **Opt-in only:** run a program with arguments in an absolute `cwd` on the go-chamber host; return exit code, bounded stdout/stderr and truncation flags |

The loop is `send_message` → `wait(since_seq)`, repeated with the `seq` each `wait` returns while
it says `running`. A request is reported as `needs_answer` once; a `wait` from after it blocks
until the owner (or the client) answers it, and names it again only at its timeout. A `wait` is
capped at 30 minutes. Keep `timeout_seconds` under the client's own tool timeout. With a progress
token, `wait` reports each finished item (message, tool call, edit) as a progress notification.
Diffs are cut at 100 000 bytes; ask for one `path` to see a long file.

## Resources

- `chamber://sessions`: the session list, JSON.
- `chamber://sessions/{id}`: a session's transcript.
- `chamber://sessions/{id}/diff`: its diff.

All three accept `resources/subscribe`:

- the list is updated when a session changes state, a turn starts or ends, or a request opens or
  closes;
- a transcript, on those and whenever one of its items finishes;
- a diff, when a turn ends or a file edit finishes.

## Safety

`run_command` is absent by default. Starting the server with `-mcp-allow-commands` exposes it to
**every currently authorized MCP client**, including clients linked before the flag was enabled.
It runs as the go-chamber OS user, with that user's file and network access. There is no shell
unless the client explicitly asks to run one (for example `/bin/sh` with `-c`); no command
allowlist or per-command owner approval. Use this flag only when you trust every linked client
and the server's authentication boundary. Each invocation requires an absolute working directory,
is limited to 60 seconds (15 by default), and returns at most 64 KiB per output stream. These
limits do **not** make an arbitrary command safe or sandbox it.

Without `-mcp-allow-approvals`, MCP clients cannot give an agent free rein:

- they may decline any request but accept only questions (Codex asks to approve MCP tool calls as
  elicitations, which count as grants);
- `start_session` refuses the unchecked modes, `bypassPermissions` and `full-access`; the asking
  and workspace-writing ones (`default`, `plan`, `acceptEdits`, `read-only`, `auto`) are fine;
- `send_message` refuses a session the owner runs in an unchecked mode.

What stays open: a session with no mode follows the agent's own configuration, including allow
rules in the project folder; and a workspace-writing agent can edit whatever lies in its folder,
the agents' own settings included when that folder is the home directory.

- Messages and decisions sent over MCP are tagged `via MCP` in the transcript and do not mark the
  session as seen.
- A session that waits on itself is not stopped: its `wait` returns `running` at the timeout.
