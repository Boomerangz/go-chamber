// formatUptime reads a duration in seconds as "1h 12m" (or "3d 2h").
export function formatUptime(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

import type { MetricKey } from '../../lib/diagnostics'

export type Level = 'none' | 'quiet' | 'elevated' | 'bad'

// Where each metric's p95 stops being quiet and becomes bad, in ms, and
// what to try when it does.
const limits: Record<MetricKey, { elevated: number; bad: number; remedy: string }> = {
  http: { elevated: 150, bad: 600, remedy: 'The server or the network is slow: check the host’s load, or the link to it.' },
  ws: { elevated: 100, bad: 400, remedy: 'Delivery is slow: a remote or mobile link adds this; the host may be busy.' },
  rtc: { elevated: 100, bad: 400, remedy: 'The direct route is slow: a TURN relay adds delay; try terminals over WebSocket below.' },
  agentBatch: { elevated: 50, bad: 200, remedy: 'Events queue before the chat applies them: the tab is busy, or a burst of output arrived.' },
  agentCommit: { elevated: 32, bad: 100, remedy: 'The chat renders slowly: a very long transcript does this; open a fresh session or fold long outputs.' },
  terminalParse: { elevated: 50, bad: 250, remedy: 'xterm is behind on output: a program printing very fast does this; it catches up once it stops.' },
  eventLoop: { elevated: 50, bad: 200, remedy: 'The browser tab is busy: close heavy tabs or extensions, or keep this one in front.' },
}

// metricLevel grades a metric's p95; past quiet it says what to try.
export function metricLevel(key: MetricKey, p95: number | null | undefined): { level: Level; remedy?: string } {
  if (p95 == null) return { level: 'none' }
  const limit = limits[key]
  if (p95 >= limit.bad) return { level: 'bad', remedy: limit.remedy }
  if (p95 >= limit.elevated) return { level: 'elevated', remedy: limit.remedy }
  return { level: 'quiet' }
}

// terminalName names a terminal for people: its title, else its folder,
// else the start of its id.
export function terminalName(id: string, terminal: { title: string; cwd: string } | undefined): string {
  if (terminal?.title) return terminal.title
  const folder = terminal?.cwd.replace(/\/+$/, '').split('/').pop()
  return folder || id.slice(0, 8)
}

export type MarkForm ='solid' | 'hollow' | 'struck' | 'dashed'

// linkMark is the form of a connection's square mark: solid when up, dashed
// while being made, struck when lost, hollow when paused.
export function linkMark(status: string): MarkForm {
  switch (status) {
    case 'online':
      return 'solid'
    case 'connecting':
    case 'reconnecting':
      return 'dashed'
    case 'paused':
      return 'hollow'
    default:
      return 'struck'
  }
}
