import { useState } from 'react'
import { diagnostics, resetDiagnostics, type MetricKey } from '../../lib/diagnostics'
import { rtcEnabled, setRTCEnabled } from '../../lib/transport'
import { useSessionStore } from '../../stores/session'
import { useTerminalStore } from '../../stores/terminals'
import { useDiagnostics } from './useDiagnostics'
import { formatUptime, linkMark, metricLevel, terminalName } from './format'
import { fail, notify } from '../../stores/notices'
import { failedTo } from '../../lib/failed'
import { LoadFailed } from '../ui/Loading'
import './DiagnosticsPage.css'

const metrics: { key: MetricKey; label: string; description: string }[] = [
  { key: 'http', label: 'HTTP round trip', description: 'Request, server snapshot and response. Sampled every 2 seconds on this page.' },
  { key: 'ws', label: 'WebSocket round trip', description: 'Echo on a separate connection to the same server. Includes network and scheduling.' },
  { key: 'rtc', label: 'WebRTC round trip', description: 'Echo on an active terminal DataChannel. Compare with WebSocket RTT; inspect its direct or TURN route below.' },
  { key: 'agentBatch', label: 'Agent batch wait', description: 'Time from the first queued event to applying its batch to the chat store.' },
  { key: 'agentCommit', label: 'Chat update', description: 'Time from a live store update to React committing the mounted chat.' },
  { key: 'terminalParse', label: 'Terminal processing', description: 'Received output to xterm’s write callback. Includes its parser queue, before screen painting.' },
  { key: 'eventLoop', label: 'Browser scheduling delay', description: 'Delay beyond a 500 ms timer interval while this tab is visible.' },
]
const ms = (value: number | null | undefined) => value == null ? '—' : `${value.toFixed(1)} ms`
const bytes = (value: number) => value >= 1048576 ? `${(value / 1048576).toFixed(1)} MiB` : `${(value / 1024).toFixed(1)} KiB`

export default function DiagnosticsPage() {
  const [enabled, setEnabled] = useState(true)
  const [rtc, setRTC] = useState(rtcEnabled)
  const { client, server, error, socketStatus, retry } = useDiagnostics(enabled)
  const connection = useSessionStore((s) => s.connection)
  const terminalNames = useTerminalStore((s) => s.terminals)
  const all = [...new Set([...client.terminals.map((t) => t.id), ...(server?.terminals.map((t) => t.id) ?? [])])]
  // A terminal no client here attached and nobody reads has nothing to show:
  // a row of dashes per shell says less than one line naming them.
  const quiet = (id: string) => {
    if (client.terminals.some((t) => t.id === id)) return false
    const remote = server?.terminals.find((t) => t.id === id)
    return !remote || (remote.clients === 0 && remote.queuedBytes === 0 && remote.laggedClients === 0)
  }
  const ids = all.filter((id) => !quiet(id))
  const idle = all.filter(quiet).map((id) => terminalName(id, terminalNames.find((t) => t.id === id)))
  const report = () => JSON.stringify({ generatedAt: new Date().toISOString(), client: diagnostics(), server }, null, 2)
  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(report())
      notify({ kind: 'info', text: 'Copied the report', key: 'copy-report' })
    } catch (err) {
      fail("Couldn't copy the report", err)
    }
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([report()], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'go-chamber-diagnostics.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  return (
    <main className="diagnostics-page" aria-label="Diagnostics">
      <header className="diagnostics-header">
        <div>
          <h2>Diagnostics</h2>
          <p>Delivery, browser responsiveness and terminal backlog. Counters contain no prompts or terminal contents.</p>
        </div>
        <div className="diagnostics-actions">
          <button className="btn" onClick={() => setEnabled((value) => !value)}>{enabled ? 'Pause probes' : 'Resume probes'}</button>
          <button className="btn" onClick={resetDiagnostics}>Reset browser samples</button>
          <button className="btn" onClick={() => void copyReport()}>Copy report</button>
          <button className="btn btn-primary" onClick={download}>Download report</button>
        </div>
      </header>
      <div className="diagnostics-status">
        <span>Agent stream: <LinkState status={connection} /></span>
        <span>Echo connection: <LinkState status={enabled ? socketStatus : 'paused'} /></span>
        <span>Browser events: <strong>{client.agent.events}</strong></span>
        <span>Long tasks: <strong>{client.browser.longTaskSupport ? client.browser.longTasks : 'unsupported'}</strong></span>
      </div>
      {error && <LoadFailed onRetry={retry}>{failedTo('load the server diagnostics', error)}</LoadFailed>}
      {error && server && <p className="diagnostics-note">The last successful server snapshot is shown below.</p>}
      <p className="diagnostics-note">Use the agent or terminal, then return here to inspect samples. Percentiles cover the latest 120 samples in this browser tab. CLI startup and model response time are not collected yet.</p>
      <div className="diagnostics-grid">
        {metrics.map(({ key, label, description }) => {
          const metric = client.metrics[key]
          const { level, remedy } = metricLevel(key, metric.p95)
          return (
            <article className="panel diagnostic-metric" key={key} data-level={level}>
              <h3>{label}</h3>
              <div className="diagnostic-value">{ms(metric.p95)} <span>p95</span>{level !== 'none' && <span className="diagnostic-level">{level}</span>}</div>
              {remedy && <p className="diagnostic-remedy">{remedy}</p>}
              <dl><div><dt>Latest</dt><dd>{ms(metric.last)}</dd></div><div><dt>Median</dt><dd>{ms(metric.p50)}</dd></div><div><dt>Maximum</dt><dd>{ms(metric.max)}</dd></div><div><dt>Samples</dt><dd>{metric.samples} / {metric.count}</dd></div></dl>
              <p>{metric.count ? description : `Waiting for samples. ${description}`}</p>
            </article>
          )
        })}
      </div>
      <section className="panel diagnostics-server" aria-label="Server diagnostics">
        <h3>Server since startup</h3>
        {server ? (
          <dl className="diagnostics-server-grid">
            <div><dt>Uptime</dt><dd>{formatUptime(server.uptimeSeconds)}</dd></div>
            <div><dt>Go heap</dt><dd>{bytes(server.heapBytes)}</dd></div>
            <div><dt>Goroutines</dt><dd>{server.goroutines}</dd></div>
            <div><dt>Published events</dt><dd>{server.events.published}</dd></div>
            <div><dt>Event persistence · mean / max</dt><dd>{ms(server.events.persistMeanMs)} / {ms(server.events.persistMaxMs)}</dd></div>
            <div><dt>Hub lock wait · mean / max</dt><dd>{ms(server.events.lockWaitMeanMs)} / {ms(server.events.lockWaitMaxMs)}</dd></div>
            <div><dt>Persistence calls / errors</dt><dd>{server.events.persistCalls} / {server.events.persistErrors}</dd></div>
            {(server.clis ?? []).map((c) => (
              <div key={c.agent}>
                <dt>{`${c.name ?? (c.agent === 'opencode' ? 'OpenCode' : c.agent === 'claude' ? 'Claude Code' : 'Codex')} CLI`}</dt>
                <dd>{c.found ? c.path || 'found' : `not found on PATH${c.hint ? ` · ${c.hint}` : ''}`}</dd>
              </div>
            ))}
          </dl>
        ) : <p>Waiting for the server snapshot.</p>}
        <p className="diagnostics-note">Persistence measures event-log append calls. Server counters are cumulative; browser reset does not reset them.</p>
      </section>
      <section className="panel diagnostics-terminals" aria-label="Terminal diagnostics">
        <h3>Terminal queues</h3>
        <label className="diagnostics-toggle">
          <input
            type="checkbox"
            checked={rtc}
            onChange={(e) => { setRTCEnabled(e.target.checked); setRTC(e.target.checked) }}
          />
          Use WebRTC for terminals on this device
        </label>
        <p className="diagnostics-note">Off keeps terminals on the WebSocket through the server. Open terminals switch right away.</p>
        {ids.length ? (
          <div className="diagnostics-table-wrap"><table>
            <thead><tr><th>Terminal</th><th>Connection</th><th>Route</th><th>WebRTC attempt</th><th>WebRTC RTT</th><th>Browser pending</th><th>Browser peak</th><th>Reconnects</th><th>Server queued</th><th>Lag resyncs</th><th>Clients</th></tr></thead>
            <tbody>{ids.map((id) => {
              const local = client.terminals.find((t) => t.id === id)
              const remote = server?.terminals.find((t) => t.id === id)
              const cells: [string, React.ReactNode][] = [
                ['Connection', local?.transport ?? '—'],
                ['Route', local?.transport === 'webrtc' ? `${local.route ?? 'unknown'} · ${local.protocol ?? 'unknown'}` : local?.transport === 'websocket' ? 'HTTP server' : '—'],
                ['WebRTC attempt', local?.rtcAttempt ? `${local.rtcAttempt.stage}${local.rtcAttempt.error ? ` · ${local.rtcAttempt.error}` : ''}${local.rtcAttempt.httpStatus ? ` · HTTP ${local.rtcAttempt.httpStatus}` : ''} · ${ms(local.rtcAttempt.elapsedMs)}` : '—'],
                ['WebRTC RTT', local?.transport === 'webrtc' ? ms(local.rtcRTTMs) : '—'],
                ['Browser pending', local ? bytes(local.pendingBytes) : '—'],
                ['Browser peak', local ? bytes(local.peakPendingBytes) : '—'],
                ['Reconnects', local?.reconnects ?? '—'],
                ['Server queued', remote ? bytes(remote.queuedBytes) : '—'],
                ['Lag resyncs', remote?.laggedClients ?? '—'],
                ['Clients', remote?.clients ?? '—'],
              ]
              // data-label names each cell when a narrow screen lays rows out as cards.
              return <tr key={id}><th scope="row">{terminalName(id, terminalNames.find((t) => t.id === id))}</th>{cells.map(([label, value]) => <td key={label} data-label={label}>{value}</td>)}</tr>
            })}</tbody>
          </table></div>
        ) : idle.length === 0 && <p>Open a terminal to collect output and queue measurements.</p>}
        {idle.length > 0 && <p className="diagnostics-idle">{`Not attached, nothing measured: ${idle.join(', ')}`}</p>}
        <p className="diagnostics-note">Browser pending bytes await xterm processing. Server queued bytes await delivery, summed across attached clients.</p>
      </section>
    </main>
  )
}

// LinkState is a connection's state as a lowercase word after a square mark
// whose form carries it.
function LinkState({ status }: { status: string }) {
  return (
    <strong className="diag-state" data-mark={linkMark(status)}>
      {status}
    </strong>
  )
}
