import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNow } from '../../lib/now'
import type { Health } from '../../lib/api'
import { useRequestsFailure, useWaitingCount } from '../../lib/waiting'
import { ChevronsRight, FileDiff, Inbox, List, MessageSquareText, SquareTerminal } from 'lucide-react'
import { icon } from '../icon'
import { DOCK_MAX, DOCK_MIN, SIDEBAR_MAX, SIDEBAR_MIN, useLayoutStore, visibleDock, type DockTab, type Mode } from '../../stores/layout'
import { useSidebarShown } from './sidebarShown'
import { formatCombo } from '../../lib/hotkeys'
import { useSessionStore, type Pane } from '../../stores/session'
import { useTerminalStore } from '../../stores/terminals'

const modes: { id: Mode; label: string }[] = [
  { id: 'agents', label: 'Agents' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'diagnostics', label: 'Diagnostics' },
]

// step finds where an arrow, Home or End moves among n items from at, or
// null for any other key. Both arrow pairs work whatever the orientation.
function step(key: string, at: number, n: number): number | null {
  if (key === 'ArrowRight' || key === 'ArrowDown') return (at + 1) % n
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (at - 1 + n) % n
  if (key === 'Home') return 0
  if (key === 'End') return n - 1
  return null
}

// ModeSwitch flips between agent sessions and the terminal workspace. As a
// radio group it is one tab stop; the arrows choose the mode.
export function ModeSwitch() {
  const mode = useLayoutStore((s) => s.mode)
  const setMode = useLayoutStore((s) => s.setMode)
  const running = useTerminalStore((s) => s.terminals.filter((t) => t.status === 'running').length)
  // What waits for the owner shows on the Agents tab while another mode
  // hides the rail and the sidebar.
  const pending = useWaitingCount()
  const waiting = mode !== 'agents' ? pending : 0
  const failure = useRequestsFailure()
  const unknown = mode !== 'agents' && failure !== null
  const group = useRef<HTMLDivElement>(null)
  return (
    <div
      ref={group}
      className="segmented mode-switch"
      role="radiogroup"
      aria-label="Mode"
      onKeyDown={(e) => {
        const at = step(e.key, modes.findIndex((m) => m.id === mode), modes.length)
        if (at === null) return
        e.preventDefault()
        setMode(modes[at]!.id)
        group.current?.querySelectorAll<HTMLElement>('[role="radio"]')[at]?.focus()
      }}
    >
      {modes.map((m, i) => (
        <button
          key={m.id}
          type="button"
          role="radio"
          aria-checked={mode === m.id}
          tabIndex={mode === m.id ? 0 : -1}
          title={`${m.label} (${i + 1})${m.id === 'agents' && unknown ? ` · requests couldn't load: ${failure}` : m.id === 'agents' && waiting > 0 ? ` · ${waiting} waiting for you` : ''}`}
          onClick={() => setMode(m.id)}
        >
          {m.label}
          {m.id === 'agents' && unknown && (
            <span className="badge failed" aria-hidden="true">
              !
            </span>
          )}
          {m.id === 'agents' && !unknown && waiting > 0 && (
            <span className="badge" aria-hidden="true">
              {waiting}
            </span>
          )}
          {m.id === 'terminal' && running > 0 && <span className="count">{running}</span>}
        </button>
      ))}
    </div>
  )
}

// focusDock moves the focus into the open dock's panel, to its first control.
function focusDock() {
  const body = document.querySelector('.dock-body')
  body?.querySelector<HTMLElement>('button:not([disabled]), input, select, textarea, a[href], [tabindex="0"]')?.focus()
}

// DockRail is the collapsed dock: one button per tab, with counts.
export function DockRail() {
  const chosen = useLayoutStore((s) => s.dock)
  const focus = useLayoutStore((s) => s.focus)
  const toggleDock = useLayoutStore((s) => s.toggleDock)
  const pending = useWaitingCount()
  const hasSession = useSessionStore((s) => Boolean(s.activeId))
  const running = useTerminalStore((s) => s.terminals.filter((t) => t.status === 'running').length)
  const failure = useRequestsFailure()
  // Pressed is what is on screen, not what was last chosen.
  const dock = visibleDock({ dock: chosen, focus }, pending, hasSession)
  // A toolbar is one tab stop; the arrows move between its buttons.
  const [current, setCurrent] = useState<string | null>(null)
  const tabs = [
    { id: 'requests' as const, label: 'Requests', icon: <Inbox {...icon(16)} />, count: pending, key: '', off: '' },
    { id: 'terminal' as const, label: 'Terminal', icon: <SquareTerminal {...icon(16)} />, count: running, key: 't', off: '' },
    { id: 'changes' as const, label: 'Changes', icon: <FileDiff {...icon(16)} />, count: 0, key: 'd', off: hasSession ? '' : 'Open a session to see its changes' },
  ]
  const ids = [...tabs.filter((t) => !t.off).map((t) => t.id as string), ...(dock && !focus ? ['collapse'] : [])]
  const stop = current !== null && ids.includes(current) ? current : (ids[0] ?? null)
  const rail = useRef<HTMLDivElement>(null)
  return (
    <div
      ref={rail}
      className="dock-rail"
      role="toolbar"
      aria-label="Dock"
      aria-orientation="vertical"
      onKeyDown={(e) => {
        const at = step(e.key, ids.indexOf(stop ?? ''), ids.length)
        if (at === null) return
        e.preventDefault()
        setCurrent(ids[at]!)
        rail.current?.querySelector<HTMLElement>(`[data-rail="${ids[at]}"]`)?.focus()
      }}
    >
      {tabs.map((t) => {
        const failed = t.id === 'requests' && failure !== null
        return (
        <button
          key={t.id}
          type="button"
          data-rail={t.id}
          className={`rail-btn rail-${t.id}`}
          aria-pressed={dock === t.id}
          aria-label={failed ? `${t.label}: couldn't load` : t.count > 0 ? `${t.label} ${t.count}` : t.label}
          title={failed ? `Couldn't load requests: ${failure}` : t.off || (t.key ? `${t.label} (${t.key})` : t.label)}
          disabled={Boolean(t.off)}
          tabIndex={stop === t.id ? 0 : -1}
          onFocus={() => setCurrent(t.id)}
          onClick={(e) => {
            const opening = dock !== t.id
            toggleDock(t.id)
            // Opened from the keyboard (a click without a pointer): the panel takes the focus.
            if (opening && e.detail === 0) requestAnimationFrame(focusDock)
          }}
        >
          {t.icon}
          {failed ? (
            <span className="rail-count failed" aria-hidden="true">
              !
            </span>
          ) : (
            t.count > 0 && (
              <span className="rail-count" aria-hidden="true">
                {t.count}
              </span>
            )
          )}
        </button>
        )
      })}
      {dock && !focus && (
        <button
          type="button"
          data-rail="collapse"
          className="rail-btn rail-collapse"
          aria-label="Collapse dock"
          title="Collapse"
          tabIndex={stop === 'collapse' ? 0 : -1}
          onFocus={() => setCurrent('collapse')}
          onClick={() => {
            toggleDock(dock)
            // This button goes with the dock: the tab that opened it keeps the focus.
            setCurrent(dock)
            rail.current?.querySelector<HTMLElement>(`[data-rail="${dock}"]`)?.focus()
          }}
        >
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
const windowWidth = (fallback: number) => (typeof window === 'undefined' ? fallback : window.innerWidth)


// DockSplitter sits on the open dock's left edge.
export function DockSplitter({ dock }: { dock: DockTab }) {
  const width = useLayoutStore((s) => s.widths[dock])
  const shown = useSidebarShown()
  const sidebar = useLayoutStore((s) => (shown ? s.sidebarWidth ?? 300 : 0))
  const setDockWidth = useLayoutStore((s) => s.setDockWidth)
  const ref = useRef<HTMLSpanElement>(null)
  const measure = () => widthOf(ref.current?.closest('.dock'))
  const max = Math.max(DOCK_MIN, Math.min(DOCK_MAX, windowWidth(DOCK_MAX) - sidebar - CHAT_MIN))
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

// focusSessions moves the focus into the sessions list: to the open
// session's row, else to the search.
function focusSessions() {
  const row = document.querySelector<HTMLElement>('button.session[aria-current="true"]')
  ;(row ?? document.querySelector<HTMLElement>('input[aria-label="Search sessions"]'))?.focus()
}

// ShowSessions brings back a sessions list hidden with ⌘B, named in the top
// bar so the way back is plain to see.
export function ShowSessions() {
  const shown = useSidebarShown()
  const hidden = useLayoutStore((s) => s.mode === 'agents' && !s.focus) && !shown
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar)
  if (!hidden) return null
  return (
    <button
      type="button"
      className="btn btn-ghost btn-xs show-sessions"
      aria-label="Show sessions"
      title={`Show sessions (${formatCombo({ key: 'b', mod: true })})`}
      onClick={() => {
        toggleSidebar()
        // This button goes as the list comes back: the focus goes into the list.
        requestAnimationFrame(focusSessions)
      }}
    >
      <ChevronsRight {...icon(14)} />
      <span className="show-sessions-label">Show sessions</span>
    </button>
  )
}

// SidebarSplitter sits on the sessions sidebar's right edge; while the
// sidebar is hidden it is a slim button that brings it back.
export function SidebarSplitter() {
  const shown = useSidebarShown()
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
  // The chat keeps its room beside the dock (or its rail) however wide the list is dragged.
  const dock = widthOf(typeof document === 'undefined' ? null : document.querySelector('.layout > .dock'))
  const max = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, windowWidth(SIDEBAR_MAX) - dock - CHAT_MIN))
  return (
    <span ref={ref} className="splitter-anchor">
      <Splitter
        label="Resize the sessions list"
        className="splitter-sidebar"
        value={width ?? undefined}
        min={SIDEBAR_MIN}
        max={max}
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
  const pending = useWaitingCount()
  const failure = useRequestsFailure()
  return (
    <nav className="panebar" aria-label="Views">
      {panes.map((p) => {
        const failed = p.id === 'requests' && failure !== null
        return (
          <button
            key={p.id}
            aria-pressed={pane === p.id}
            aria-label={failed ? `${p.label}: couldn't load` : undefined}
            title={failed ? `Couldn't load requests: ${failure}` : undefined}
            onClick={() => setPane(p.id)}
          >
            {p.icon}
            {p.label}
            {failed ? (
              <span className="badge failed" aria-hidden="true">
                !
              </span>
            ) : (
              p.id === 'requests' && pending > 0 && <span className="badge">{pending}</span>
            )}
          </button>
        )
      })}
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
    const words = `reconnecting${wait > 0 ? ` · ${wait}s` : '…'}`
    return (
      <button
        type="button"
        className="health health-reconnecting"
        aria-label={words}
        title="Live updates dropped. Click to reconnect now."
        onClick={retryNow}
      >
        <span className="dot" aria-hidden="true" />
        <span className="health-words">{words}</span>
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

