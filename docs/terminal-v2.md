# Responsive terminal protocol v2

Enable with `go-chamber -terminal-v2`. The default remains v1 until the physical
phone sleep and Wi-Fi → cellular smoke below is recorded as passed. Terminal
CRUD endpoints are unchanged. The list response advertises the selected
protocol in `X-Go-Chamber-Terminal-Protocol`.

## Canonical screen and recovery

The app owns a `TerminalScreen` port, implemented by the pinned x/vt adapter.
Every PTY output byte advances the screen even without browsers attached.
Snapshots and subscriptions are captured under the same lock and carry the
PTY byte position. A snapshot restores the primary/alternate buffers, cells,
styles, links, cursor and saved cursor, dimensions, observed input modes,
scroll regions, tab stops, character sets, colors and incomplete UTF-8/ANSI.
There are no screen deltas. During replacement the browser retains an image
of the previous screen, then removes it after xterm finishes the new screen.
Connection generations fence stale messages and parser callbacks.

Terminal queries are answered by the server, including without a browser.
The v2 browser suppresses xterm's duplicate replies. Completed OSC 52 clipboard
commands and prompt hooks are absent from snapshots; clipboard events are
ignored during recovery. History is read as plain text, outside xterm.

The adapter uses the same Unicode 11 widths as `@xterm/addon-unicode11@0.9.0`.
For example, `👩‍💻` takes four columns. `unicode11.go` and the UI addon must be
updated together; the upstream license is in `UNICODE-LICENSE`.

The local `third_party/vt` patch disables hidden alternate scrollback and
matches xterm's legacy alternate-buffer cursor behavior. Its provenance and
changes are in `third_party/vt/GO-CHAMBER.md`; its upstream tests run in
`make check`. The browser screen contracts compare an actual mounted xterm,
restoration, continued output, a second canonical snapshot and query replies.
Run them separately with `bash scripts/terminal-screen-gate`.

## Delivery and input

WebSocket `/api/terminals/{id}/pty?v=2&client={tab-id}` is the mandatory baseline.
WebRTC uses reliable ordered `terminal-control-v2` and `terminal-output-v2`
data channels. Input, input ACKs, ownership and output ACKs use control;
snapshot/ready/prompt and output use the ordered output channel. An RTC
candidate replaces WebSocket only after attachment; failures return to
WebSocket and retry RTC with bounded backoff (up to 30 seconds).
Gathering (up to 8 seconds), answer signaling (15 seconds) and connection
establishment (20 seconds) have separate budgets. Pion's initial ICE deadline
is 40 seconds, with a 45-second bound on unopened peers, so answer delivery
does not prematurely expire the server. No TURN is required or added for
this direct-path recovery: unreachable paths continue using WebSocket.

Output frames are at most 16 KiB including a 9-byte header: kind (1 live,
2 snapshot), uint64 big-endian PTY position, payload. Cumulative application
ACKs count payload bytes only and release a 64 KiB window after xterm parses
the bytes. The existing 4 MiB queued-output threshold replaces unsent backlog
with a current full snapshot. Bytes already passed to the transport cannot
be recalled. Input remains independently readable, including Ctrl-C.

Input frames have kind 3, uint64 epoch, uint64 byte offset, then payload
(17-byte header, total at most 16 KiB). ACKs identify only the prefix actually
written to the PTY, including partial writes. They do not acknowledge command
execution. Reconnect skips previously written bytes. A server-run change
cancels pending input; an ambiguous write blocks automatic replay until
explicit control reset. Pending input lives only in tab memory, capped at
64 KiB. Overflow visibly pauses new input; no prefix is silently trimmed.
Reloading the page does not persist pending keystrokes or client identity.

Servers advertise `inputPipeline: true` in `hello`: clients immediately send
subsequent keystrokes within the 64 KiB unacknowledged input window, without
waiting a round trip between keys. Older servers retain single-flight input.
The server completes successful short PTY writes before reading the next input
frame, acknowledging each written prefix and stopping on uncertainty, loss of
ownership or transport failure. Reconnect reconciles the prefix before replay.

The first client controls input/resize; other clients observe and can choose
**Take control**. Ownership survives transport reconnect until explicit
transfer. Takeover is serialized with PTY writes, advances the control epoch
and explicitly cancels pending input from the previous owner. A page reload
creates a new client and must take control again.

Online, pageshow, focus, visible-tab and network-change events trigger
recovery; heartbeats detect dead transports. Shells continue running without
a browser for the lifetime of go-chamber. Restarting go-chamber ends them.

## Separate history and predictions

Primary-screen history retains at most 10,000 lines and 10 MiB per terminal.
Stable line IDs support before-ID paging, search and an eviction boundary via
`GET /api/terminals/{id}/history?before=&limit=&q=`. The v2 history button opens
an independent reader. Alternate-screen redraws do not enter that history.

Bash and zsh startup wrappers are private temporary files; user dotfiles are
sourced without editing them. Other shells run normally without predictions.
Bash predictions require version 4.4 or newer (PS0 command marker); macOS
`/bin/bash` 3.2 deliberately runs without prediction capability.

Predictions require a confirmed OSC 133 prompt and matching simple echo.
Only simple ASCII/Cyrillic text and Backspace are projected in a temporary
layer; xterm's canonical screen is never modified. RTT hysteresis enables
predictions above 30 ms and disables them below 20 ms. Paste, control input,
Enter, divergence, resize, disconnect and ownership changes clear the layer.
After Enter a fresh command generation and prompt are required, so delayed
old prompt events cannot activate predictions in a password prompt or TUI.

## Diagnostics and verification

Diagnostics contain counters/timing only, never terminal content: recovery
time, pending parser/output bytes, server queue, resync count, unacknowledged
output and pending input. **Processed age** is time since xterm last parsed
output; it grows during idle periods and is not end-to-end output latency.
WebRTC RTT is sampled only on an active RTC control channel. An empty metric
explains whether RTC is disabled, no terminal is attached in this tab, or the
tab currently uses WebSocket. The WebRTC attempt column and report retain the
negotiation stage, HTTP failure/timeout, ICE states, candidate counts and ICE
error codes for v2 as well as v1. SDP, candidate addresses and ICE credentials
are not included in diagnostics.

Automated coverage includes Unicode/colors/cursors/alternate buffers/resize,
lost ACKs and partial PTY writes, output after disconnect, stale callbacks,
restart and uncertain-write cancellation, two-tab control, stalled output
with Ctrl-C, real dual-channel RTC failure/fallback/retry, delayed echo,
password input and shell → TUI → shell. Playwright injects deterministic
transport faults and runs against isolated servers with disposable homes.
No installed live service needs restarting to run these tests.

Before making v2 the default:

1. Run `make check` and the strict screen gate; do not run mutation testing.
2. Start an isolated v2 instance reachable from the test phone using the
   existing deployment's authenticated access (do not expose a new public port).
3. Open a shell on the phone, run continuous numbered output, lock/sleep the
   phone, then wake it. Verify current-screen recovery and continued input.
4. Switch Wi-Fi → cellular while output continues. Verify WebSocket fallback,
   recovery, working Ctrl-C and eventual RTC retry when available.
5. Check two clients, explicit takeover and one-time command execution across
   disconnects; record phone/browser/network and results in the release notes.

Physical phone smoke has **not** been performed. The available automation
surfaces expose desktop apps only. V2 stays opt-in pending that validation.

Verified on 2026-10-30: `make check` passed with three Playwright workers:
Go race tests and coverage (90.8% overall), lint/typecheck, 1,774 Web tests,
protocol utility and local vt tests, and 596 e2e tests (124 conditional skips).
All 66 screen contracts and all 16 v2 transport/history/control/prediction
scenarios passed. No mutation testing was run. A temporary lint wrapper used
the standard `--allow-parallel-runners` flag because another project held the
machine-wide lint lock; the repository's check commands remain unchanged.

Input-pipeline verification on 2026-10-30: `make check` passed again with
1,778 Web tests and 598 e2e passes (124 conditional skips), including all
18 v2 scenarios. A deterministic browser test withholds input ACKs and
confirms the next keystroke reaches the PTY before releasing them. Short-write
tests cover written-prefix ACKs, uncertainty, takeover and a broken transport.
