import type { ReactNode } from 'react'
import { useNow } from '../../lib/now'
import type { Health } from '../../lib/api'
import { ChevronsRight, FileDiff, Inbox, List, MessageSquareText, SquareTerminal } from 'lucide-react'
import { icon } from '../icon'
import { useLayoutStore, type Mode } from '../../stores/layout'
import { useSessionStore, type Pane } from '../../stores/session'
import { useTerminalStore } from '../../stores/terminals'

const modes: { id: Mode; label: string }[] = [
  { id: 'agents', label: 'Agents' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'diagnostics', label: 'Diagnostics' },
]

// ModeSwitch flips between agent sessions and the terminal workspace.
export function ModeSwitch() {
  const mode = useLayoutStore((s) => s.mode)
  const setMode = useLayoutStore((s) => s.setMode)
  const running = useTerminalStore((s) => s.terminals.filter((t) => t.status === 'running').length)
  return (
    <div className="segmented mode-switch" role="radiogroup" aria-label="Mode">
      {modes.map((m, i) => (
        <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} title={`${m.label} (${i + 1})`} onClick={() => setMode(m.id)}>
          {m.label}
          {m.id === 'terminal' && running > 0 && <span className="count">{running}</span>}
        </button>
      ))}
    </div>
  )
}

// DockRail is the collapsed dock: one button per tab, with counts.
export function DockRail() {
  const dock = useLayoutStore((s) => s.dock)
  const toggleDock = useLayoutStore((s) => s.toggleDock)
  const pending = useSessionStore((s) => s.pendingRequests.length)
  const running = useTerminalStore((s) => s.terminals.filter((t) => t.status === 'running').length)
  const tabs = [
    { id: 'requests' as const, label: 'Requests', icon: <Inbox {...icon(16)} />, count: pending },
    { id: 'terminal' as const, label: 'Terminal', icon: <SquareTerminal {...icon(16)} />, count: running },
    { id: 'changes' as const, label: 'Changes', icon: <FileDiff {...icon(16)} />, count: 0 },
  ]
  return (
    <div className="dock-rail" role="toolbar" aria-label="Dock" aria-orientation="vertical">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`rail-btn rail-${t.id}`}
          aria-pressed={dock === t.id}
          aria-label={t.count > 0 ? `${t.label} ${t.count}` : t.label}
          title={t.label}
          onClick={() => toggleDock(t.id)}
        >
          {t.icon}
          {t.count > 0 && (
            <span className="rail-count" aria-hidden="true">
              {t.count}
            </span>
          )}
        </button>
      ))}
      {dock && (
        <button type="button" className="rail-btn rail-collapse" aria-label="Collapse dock" title="Collapse" onClick={() => toggleDock(dock)}>
          <ChevronsRight {...icon(16)} />
        </button>
      )}
    </div>
  )
}

const panes: { id: Pane; label: string; icon: ReactNode }[] = [
  { id: 'sessions', label: 'Sessions', icon: <List {...icon(18)} /> },
  { id: 'chat', label: 'Chat', icon: <MessageSquareText {...icon(18)} /> },
  { id: 'requests', label: 'Requests', icon: <Inbox {...icon(18)} /> },
  { id: 'changes', label: 'Changes', icon: <FileDiff {...icon(18)} /> },
]

// PaneBar switches views on narrow screens; hidden on desktop by CSS.
export function PaneBar() {
  const pane = useSessionStore((s) => s.pane)
  const setPane = useSessionStore((s) => s.setPane)
  const pending = useSessionStore((s) => s.pendingRequests.length)
  return (
    <nav className="panebar" aria-label="Views">
      {panes.map((p) => (
        <button key={p.id} aria-pressed={pane === p.id} onClick={() => setPane(p.id)}>
          {p.icon}
          {p.label}
          {p.id === 'requests' && pending > 0 && <span className="badge">{pending}</span>}
        </button>
      ))}
    </nav>
  )
}

// HealthStatus is the top bar's link state: the server's health, and once
// online, whether the live socket is up. A dropped socket offers a retry.
export function HealthStatus({ health }: { health: Health | null }) {
  const connection = useSessionStore((s) => s.connection)
  const nextRetryAt = useSessionStore((s) => s.nextRetryAt)
  const retryNow = useSessionStore((s) => s.retryNow)
  const now = useNow(health === 'online' && connection === 'offline' ? 1000 : null)
  if (health === 'online' && connection === 'offline') {
    const wait = nextRetryAt ? Math.max(0, Math.ceil((nextRetryAt - now) / 1000)) : 0
    return (
      <button
        type="button"
        className="health health-reconnecting"
        title="Live updates dropped. Click to reconnect now."
        onClick={retryNow}
      >
        <span className="dot" aria-hidden="true" />
        reconnecting{wait > 0 ? ` · ${wait}s` : '…'}
      </button>
    )
  }
  const state = health ?? 'connecting'
  return (
    <span className={`health health-${state}`} role="status">
      <span className="dot" aria-hidden="true" />
      {state}
    </span>
  )
}
