import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNow } from '../../lib/now'
import type { Health } from '../../lib/api'
import { ChevronsRight, FileDiff, Inbox, List, MessageSquareText, SquareTerminal } from 'lucide-react'
import { icon } from '../icon'
import { DOCK_MAX, DOCK_MIN, SIDEBAR_MAX, SIDEBAR_MIN, useLayoutStore, visibleDock, type DockTab, type Mode } from '../../stores/layout'
import { formatCombo } from '../../lib/hotkeys'
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
  const chosen = useLayoutStore((s) => s.dock)
  const focus = useLayoutStore((s) => s.focus)
  const toggleDock = useLayoutStore((s) => s.toggleDock)
  const pending = useSessionStore((s) => s.pendingRequests.length)
  const hasSession = useSessionStore((s) => Boolean(s.activeId))
  const running = useTerminalStore((s) => s.terminals.filter((t) => t.status === 'running').length)
  // Pressed is what is on screen, not what was last chosen.
  const dock = visibleDock({ dock: chosen, focus }, pending, hasSession)
  const tabs = [
    { id: 'requests' as const, label: 'Requests', icon: <Inbox {...icon(16)} />, count: pending, key: '', off: '' },
    { id: 'terminal' as const, label: 'Terminal', icon: <SquareTerminal {...icon(16)} />, count: running, key: 't', off: '' },
    { id: 'changes' as const, label: 'Changes', icon: <FileDiff {...icon(16)} />, count: 0, key: 'd', off: hasSession ? '' : 'Open a session to see its changes' },
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
          title={t.off || (t.key ? `${t.label} (${t.key})` : t.label)}
          disabled={Boolean(t.off)}
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
      {dock && !focus && (
        <button type="button" className="rail-btn rail-collapse" aria-label="Collapse dock" title="Collapse" onClick={() => toggleDock(dock)}>
          <ChevronsRight {...icon(16)} />
        </button>
      )}
    </div>
  )
}

const KEY_STEP = 16
// The chat keeps at least this much room when a dock or the sidebar grows.
const CHAT_MIN = 360

// Splitter is a 4px handle on a column edge: drag it (or use ←/→) to
// resize, double-click to go back to the default width.
function Splitter(props: {
  label: string
  className: string
  // value is the remembered width; without one the column is measured.
  value: number | undefined
  min: number
  max: number
  // grows: +1 when dragging right widens the column, -1 when left does.
  grows: 1 | -1
  measure: () => number
  onChange: (px: number) => void
  onReset: () => void
}) {
  const { grows, measure, onChange } = props
  const drag = useRef<{ x: number; width: number } | null>(null)
  const clamp = (px: number) => Math.min(props.max, Math.max(props.min, px))
  // A separator always says where it stands: the remembered width, else the
  // column as laid out (measured once it and its anchor are on screen).
  const [measured, setMeasured] = useState<number>()
  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- the width is read from the laid-out DOM
    if (props.value === undefined) setMeasured(Math.round(measure()))
  }, [props.value, measure])
  const now = props.value ?? (measured === undefined ? undefined : clamp(measured))
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuenow={now}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      tabIndex={0}
      title={`${props.label}: drag, or double-click for the default width`}
      className={`splitter ${props.className}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture?.(e.pointerId)
        drag.current = { x: e.clientX, width: measure() }
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        onChange(clamp(drag.current.width + grows * (e.clientX - drag.current.x)))
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={props.onReset}
      onKeyDown={(e) => {
        const step = e.key === 'ArrowRight' ? KEY_STEP : e.key === 'ArrowLeft' ? -KEY_STEP : 0
        if (!step) return
        e.preventDefault()
        onChange(clamp((props.value ?? measure()) + grows * step))
      }}
    />
  )
}

const widthOf = (el: Element | null | undefined) => el?.getBoundingClientRect().width ?? 0

// DockSplitter sits on the open dock's left edge.
export function DockSplitter({ dock }: { dock: DockTab }) {
  const width = useLayoutStore((s) => s.widths[dock])
  const sidebar = useLayoutStore((s) => (s.sidebar ? s.sidebarWidth ?? 300 : 0))
  const setDockWidth = useLayoutStore((s) => s.setDockWidth)
  const ref = useRef<HTMLSpanElement>(null)
  const measure = () => widthOf(ref.current?.closest('.dock'))
  const max = Math.max(DOCK_MIN, Math.min(DOCK_MAX, (typeof window === 'undefined' ? DOCK_MAX : window.innerWidth) - sidebar - CHAT_MIN))
  return (
    <span ref={ref} className="splitter-anchor">
      <Splitter
        label="Resize the dock"
        className="splitter-dock"
        value={width ?? undefined}
        min={DOCK_MIN}
        max={max}
        grows={-1}
        measure={measure}
        onChange={(px) => setDockWidth(dock, px)}
        onReset={() => setDockWidth(dock, null)}
      />
    </span>
  )
}

// ShowSessions brings back a sessions list hidden with ⌘B, named in the top
// bar so the way back is plain to see.
export function ShowSessions() {
  const hidden = useLayoutStore((s) => s.mode === 'agents' && !s.sidebar && !s.focus)
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar)
  if (!hidden) return null
  return (
    <button
      type="button"
      className="btn btn-ghost btn-xs show-sessions"
      title={`Show sessions (${formatCombo({ key: 'b', mod: true })})`}
      onClick={toggleSidebar}
    >
      <ChevronsRight {...icon(14)} />
      Show sessions
    </button>
  )
}

// SidebarSplitter sits on the sessions sidebar's right edge; while the
// sidebar is hidden it is a slim button that brings it back.
export function SidebarSplitter() {
  const shown = useLayoutStore((s) => s.sidebar)
  const width = useLayoutStore((s) => s.sidebarWidth)
  const setSidebarWidth = useLayoutStore((s) => s.setSidebarWidth)
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar)
  const ref = useRef<HTMLSpanElement>(null)
  if (!shown) {
    return (
      <button
        type="button"
        className="splitter sidebar-show"
        aria-label="Show sessions"
        aria-hidden="true"
        tabIndex={-1}
        title={`Show sessions (${formatCombo({ key: 'b', mod: true })})`}
        onClick={toggleSidebar}
      >
        <ChevronsRight {...icon(14)} />
      </button>
    )
  }
  const measure = () => widthOf(ref.current?.parentElement?.querySelector(':scope > .sidebar'))
  return (
    <span ref={ref} className="splitter-anchor">
      <Splitter
        label="Resize the sessions list"
        className="splitter-sidebar"
        value={width ?? undefined}
        min={SIDEBAR_MIN}
        max={SIDEBAR_MAX}
        grows={1}
        measure={measure}
        onChange={setSidebarWidth}
        onReset={() => setSidebarWidth(null)}
      />
    </span>
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
  // While connecting the page says so in full; the bar keeps just the mark.
  if (state === 'connecting') {
    return (
      <span className="health health-connecting" role="status" aria-label="connecting" title="connecting to go-chamber">
        <span className="dot" aria-hidden="true" />
      </span>
    )
  }
  // All is well most of the time: then only the mark shows, and says so on hover.
  if (state === 'online' && connection !== 'offline') {
    return (
      <span className="health health-online" role="status" aria-label="online" title="online · live updates connected">
        <span className="dot" aria-hidden="true" />
      </span>
    )
  }
  return (
    <span className={`health health-${state}`} role="status">
      <span className="dot" aria-hidden="true" />
      {state}
    </span>
  )
}

// SignOut asks once before signing out: signing back in needs the access
// token go-chamber printed at startup.
export function SignOut({ className }: { className?: string }) {
  const [asking, setAsking] = useState(false)
  // Cancelling hands focus back to the button that asked.
  const refocus = useRef(false)
  const ask = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!asking && refocus.current) {
      refocus.current = false
      ask.current?.focus()
    }
  }, [asking])
  const cancel = () => {
    refocus.current = true
    setAsking(false)
  }
  if (!asking) {
    return (
      <div className={className}>
        <button ref={ask} type="button" className="btn btn-ghost" onClick={() => setAsking(true)}>
          Sign out
        </button>
      </div>
    )
  }
  return (
    <form
      method="post"
      action="/logout"
      className={`${className ?? ''} signout-confirm`}
      role="group"
      aria-label="Sign out"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        cancel()
      }}
    >
      <span className="signout-question" title={SIGN_BACK_IN}>
        Sign out?
      </span>
      <button type="submit" className="btn btn-danger btn-xs" autoFocus title={SIGN_BACK_IN}>
        Sign out
      </button>
      <button type="button" className="btn btn-ghost btn-xs" onClick={cancel}>
        Cancel
      </button>
    </form>
  )
}

const SIGN_BACK_IN = "Signing back in needs the access token go-chamber printed at startup."

