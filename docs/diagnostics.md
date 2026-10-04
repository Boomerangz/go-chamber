# Diagnostics

Open **Diagnostics** in the top bar or `/diagnostics`. HTTP and WebSocket
probes run every two seconds while this page is open. Pause stops both probes;
Reset browser samples clears local counters, preserving outstanding terminal
writes until their processing callbacks finish. Server counters continue
from server startup. Download report exports a JSON snapshot without message
text, shell contents or authentication tokens.

Use an agent or terminal, then return to this page to inspect its measurements.
Each timing retains the latest 120 samples and shows median, p95 and maximum.
Browser counters belong to this tab and are lost on reload.

- HTTP round trip includes obtaining the server snapshot. WebSocket round trip
  measures an echo on a separate connection to the same server.
- WebRTC round trip echoes over the active terminal DataChannel, including any
  ordered output queued before the echo. The terminal table identifies the
  selected connection as direct or TURN relay and shows its candidate protocol.
- Agent batch wait measures the first queued event to application of its batch.
  Chat update measures a live store update to React's mounted-chat commit.
  Neither measures CLI startup or model response time.
- Terminal processing ends at xterm's write callback, before screen painting.
  Browser pending bytes await that callback. Server queued chunks await delivery
  to WebSocket clients and are summed across attached clients.
- Persistence timings cover event-log Append calls. Hub lock wait can reveal
  contention with persistence and other hub operations. Long tasks and browser
  scheduling delay help identify a busy browser; hidden-tab intervals are skipped.

Compare these measurements before changing transports. High echo latency points
to network or scheduling; fast echoes with slow chat updates or terminal processing
point to work in the browser. Lag disconnects indicate clients falling behind
server output. Measurements are observational and do not execute extra agent
requests or terminal commands.

The WebRTC attempt column retains the last negotiation stage and failure category,
including an HTTP status when signaling fails. Reports also include elapsed time,
ICE/connection states, numeric ICE error codes and counts of local and remote
`host`, `srflx` and `relay` candidates. No addresses or error text are exported.
A `gathering` timeout means the browser never reached offer signaling; a
`connecting` failure means an answer was obtained but the channel did not open.
Only host candidates may work on a shared LAN but often cannot cross NAT.
Reload the page to start a fresh attempt after changing the network or ICE config.
Reset browser samples preserves the last attempt so the fallback reason is not lost.

## Direct terminal connections

Terminals open immediately through WebSocket and attempt an encrypted, reliable,
ordered WebRTC DataChannel. HTTPS carries authenticated offer/answer signaling;
terminal bytes then use the selected ICE path. A direct connection bypasses
the HTTP proxy and reverse TCP tunnel. A failed attempt leaves WebSocket active;
a lost peer restores WebSocket and replays scrollback. The switch replays the
screen once, so input is briefly held while terminal queries in replay are
processed. Inputs already sent are never retried, to avoid executing commands twice.

WebRTC needs a secure browser context (HTTPS or localhost) and reachable UDP.
The default discovery service is `stun:stun.cloudflare.com:3478`. STUN discovers
addresses; it does not relay terminal data. The browser and go-chamber both
contact it when negotiating a terminal connection. Symmetric NAT or blocked
UDP may require TURN; without a reachable path the terminal uses WebSocket.

Set `GO_CHAMBER_ICE_SERVERS` or `-rtc-ice` to a JSON array of ICE servers:

```json
[{"urls":["stun:stun.example.org:3478"]},
 {"urls":["turn:turn.example.org:3478"],"username":"user","credential":"password"}]
```

Use an environment variable for credentials. The authenticated browser receives
the ICE configuration; exports contain neither credentials, SDP nor candidate
addresses. `-rtc-ice '[]'` uses only host candidates, useful for local tests.
Only the terminal stream uses this transport; chat event delivery stays on its
existing server connection. Actual latency improvement depends on the selected
network route; compare WebRTC RTT with WebSocket RTT on Diagnostics.
