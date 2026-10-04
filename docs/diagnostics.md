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
