import { useEffect, useRef, useState, type MouseEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { PictureInPicture2 } from 'lucide-react'
import { sessionTitle } from '../../lib/sessions'
import { basename } from '../../lib/format'
import { markSeen, type Session } from '../../lib/api'
import { failedTo } from '../../lib/failed'
import { isUnseen } from '../../lib/visits'
import { useWaitingCount } from '../../lib/waiting'
import { fleet } from '../../lib/fleet'
import { brief, elapsed, useAttention } from '../../stores/attention'
import { fail } from '../../stores/notices'
import { useSessionStore } from '../../stores/session'
import { useLayoutStore } from '../../stores/layout'
import RequestTray from '../requests/RequestTray'
import LiveStrip from '../chat/LiveStrip'
import { LoadFailed, LoadingLine } from '../ui/Loading'
import './AttentionWindow.css'

interface PictureInPictureAPI {
  requestWindow(options: { width: number; height: number }): Promise<Window>
}

export default function AttentionWindow() {
  const api = (window as Window & { documentPictureInPicture?: PictureInPictureAPI }).documentPictureInPicture
  const [child, setChild] = useState<Window | null>(null)
  const [opening, setOpening] = useState(false)
  const current = useRef<Window | null>(null)
  const busy = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; current.current?.close() }
  }, [])

  const open = async () => {
    if (!api || busy.current) return
    if (current.current && !current.current.closed) { current.current.focus(); return }
    busy.current = true
    setOpening(true)
    try {
      const win = await api.requestWindow({ width: 420, height: 560 })
      if (!mounted.current) { win.close(); return }
      current.current = win
      win.document.title = 'go-chamber · Floating panel'
      const base = win.document.createElement('base')
      base.href = document.baseURI
      win.document.head.append(base)
      for (const style of document.querySelectorAll('style, link[rel="stylesheet"]')) {
        win.document.head.append(style.cloneNode(true))
      }
      win.document.body.className = 'attention-body'
      win.addEventListener('pagehide', () => {
        if (current.current === win) {
          current.current = null
          if (mounted.current) setChild(null)
        }
      }, { once: true })
      setChild(win)
    } catch (err) {
      current.current?.close()
      current.current = null
      // A notice, not the top bar: the browser's reason can be long.
      if (mounted.current) fail(failedTo('open the floating panel'), err, 'floating-panel')
    } finally {
      busy.current = false
      if (mounted.current) setOpening(false)
    }
  }
  return <>
    <button type="button" className="btn btn-ghost btn-icon pip-toggle" aria-label="Open floating panel"
      aria-pressed={!!child} aria-busy={opening || undefined} disabled={!api || opening}
      title={api ? 'Floating panel · keep agents visible above other apps' : 'Floating panel requires desktop Chrome or Edge (HTTPS or localhost)'}
      onClick={() => void open()}><PictureInPicture2 size={16} /></button>
    {child && createPortal(<AttentionPanel />, child.document.body)}
  </>
}

function timestamp(value?: string): number | undefined {
  const n = Date.parse(value || '')
  return Number.isFinite(n) ? n : undefined
}

// markResultSeen tells the server the owner has seen the session's last
// turn, as opening its chat does: the sidebar's mark and every device's
// Overview drop it. The card goes at once; a refusal brings it back.
async function markResultSeen(id: string): Promise<void> {
  const attention = useAttention.getState()
  attention.dismiss(id)
  try {
    await markSeen(id)
  } catch (err) {
    useAttention.getState().undismiss(id)
    fail(failedTo('mark the result seen'), err, 'result-seen')
  }
}

// useFirstWaitingFocus: the Overview opens on its first waiting row, as the
// chat does on a request card, so the row's a/s/d answer it at once. It
// takes focus once, the first time a row is there, and never from a field
// being typed in (nor anywhere in a touch screen's text fields: a row is no
// text field, so no keyboard comes up). The floating panel is another window
// and leaves focus where it is.
function useFirstWaitingFocus(panel: RefObject<HTMLElement | null>, standalone: boolean, waiting: number) {
  const done = useRef(false)
  useEffect(() => {
    if (!standalone || done.current || waiting === 0) return
    const row = panel.current?.querySelector<HTMLElement>('.attention-inbox .tray-row')
    if (!row) return
    done.current = true
    const active = row.ownerDocument.activeElement
    if (active instanceof HTMLElement && (active.isContentEditable || active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) return
    if (active && panel.current?.contains(active)) return
    row.focus({ preventScroll: true })
  }, [panel, standalone, waiting])
}

// SAME_TIMER_MS: a wait that began this soon after its task reads as the
// task's own clock.
const SAME_TIMER_MS = 5000

// pointToRequest moves to the session's request in the inbox above: the
// card says it waits, the inbox is where it is answered.
function pointToRequest(event: MouseEvent<HTMLButtonElement>, id: string) {
  const row = event.currentTarget.ownerDocument.querySelector<HTMLElement>(`.tray-row[data-key^="${CSS.escape(id)}/"]`)
  row?.scrollIntoView?.({ block: 'nearest' })
  row?.focus()
}

export function AttentionPanel({ standalone = false }: { standalone?: boolean }) {
  const sessions = useSessionStore((s) => s.sessions)
  const requests = useSessionStore((s) => s.pendingRequests)
  const connection = useSessionStore((s) => s.connection)
  const sessionsStatus = useSessionStore((s) => s.sessionsStatus)
  const sessionsError = useSessionStore((s) => s.sessionsError)
  const select = useSessionStore((s) => s.selectSession)
  const waitingCount = useWaitingCount()
  const entries = useAttention((s) => s.entries)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  // The store fetches a session's history once, then follows it live; it
  // asks again only for what a dropped socket may have missed.
  const refreshKey = sessions.map((s) => `${s.id}:${s.status}:${s.endedAt ?? ''}:${s.seen?.at ?? ''}`).join('|')
  const wasOnline = useRef(false)
  const dropped = useRef(false)
  useEffect(() => {
    if (connection !== 'online') {
      if (wasOnline.current) dropped.current = true
      return
    }
    wasOnline.current = true
    const catchUp = dropped.current
    dropped.current = false
    void useAttention.getState().refresh(useSessionStore.getState().sessions, { catchUp })
  }, [connection, refreshKey])
  const top = sessions.filter((s) => !s.parentId)
  const { running } = fleet(sessions, requests, waitingCount)
  // A result is news until the owner looks at the session on any device.
  const isResult = (s: Session) => s.status !== 'running' && isUnseen(s) && !entries[s.id]?.dismissed
  const visible = top.filter((s) => s.status === 'running' || isResult(s))
  const priority = (s: Session) => requests.some((r) => r.sessionId === s.id) ? 0 : isResult(s) && entries[s.id]?.outcome === 'Failed' ? 1 : isResult(s) ? 3 : 2
  visible.sort((a, b) => priority(a) - priority(b))
  const returnToChat = () => {
    useLayoutStore.getState().setMode('agents')
    if (!standalone) window.focus()
  }
  const open = (s: Session) => { void select(s.id); returnToChat() }
  const panel = useRef<HTMLElement>(null)
  useFirstWaitingFocus(panel, standalone, waitingCount)
  return <section ref={panel} className={standalone ? "attention-panel attention-overview" : "attention-panel"} aria-label={standalone ? "Overview" : "Floating activity"}>
    <header>{standalone ? <h2>Overview</h2> : <strong>go-chamber</strong>}<button className="btn btn-xs attention-leave" onClick={() => { useSessionStore.getState().setPane(standalone ? 'sessions' : 'chat'); returnToChat() }}>{standalone ? 'Sessions' : 'Open workspace'}</button></header>
    {sessionsStatus === 'ready' && <p className="attention-summary">{running} running · {waitingCount} waiting</p>}
    <LiveStrip />
    <div className="attention-inbox" onClick={(event) => {
      // RequestTray navigates questions and interrupted sessions in the main app.
      // Use the child's DOM realm: instanceof HTMLElement would reject its nodes.
      const target = event.target as Element
      if (target.closest('.tray-row')) returnToChat()
    }}><RequestTray /></div>
    <section aria-label="Session activity">
      <h2 className="section-title">Session activity</h2>
      {sessionsStatus === 'loading' && <LoadingLine>loading sessions…</LoadingLine>}
      {sessionsStatus === 'error' && <LoadFailed onRetry={() => void useSessionStore.getState().loadSessions()}>{failedTo('load sessions', sessionsError)}</LoadFailed>}
      {visible.map((s) => {
        const entry = entries[s.id]
        const done = s.status !== 'running'
        const pending = requests.filter((r) => r.sessionId === s.id)
        const waits = pending.map((r) => timestamp(r.openedAt) ?? entry?.waiting[r.id]).filter((at): at is number => at !== undefined)
        const waitSince = waits.length ? Math.min(...waits) : undefined
        const actions = Object.values(entry?.actions || {})
        const action = actions[actions.length - 1]
        const start = entry?.startedAt ?? timestamp(s.activeAt)
        const end = entry?.endedAt ?? timestamp(s.endedAt)
        const clock = done && end === undefined ? '—' : elapsed(start, done ? end! : now)
        // A wait that began with the task is the header's clock already;
        // only one that began later has a clock of its own.
        const waitClock = waitSince !== undefined && (start === undefined || waitSince - start >= SAME_TIMER_MS)
        const outcome = entry?.outcome ?? 'Finished'
        const task = entry?.summary || sessionTitle(s)
        return <article className="attention-session" key={s.id} data-outcome={done ? outcome : undefined}>
          <div className="attention-session-head"><span>{basename(s.cwd)} · {s.agent}</span><span aria-label="Task elapsed" title={done ? 'Task duration' : 'Time since the task started'}>{clock}</span></div>
          <button className="attention-task" title={task} onClick={() => { if (done) void markResultSeen(s.id); open(s) }}>{task}</button>
          {done ? <>
            <div className="attention-result-line">
              <strong className="attention-outcome">{outcome}</strong>
              {entry?.result && <p className="attention-result" title={entry.result}>{brief(entry.result)}</p>}
              <div className="attention-result-actions">
                <button className="btn btn-xs" onClick={() => { void markResultSeen(s.id); open(s) }}>Open result</button>
                <button className="btn btn-xs btn-ghost" aria-label="Dismiss result" onClick={() => void markResultSeen(s.id)}>Dismiss</button>
              </div>
            </div>
          </> : pending.length ? <button type="button" className="attention-waiting" title="Answer it in Waiting for you above" onClick={(e) => pointToRequest(e, s.id)}>
            <span>Waiting for you · answer above</span>
            {waitClock && <span aria-label="Waiting elapsed">{elapsed(waitSince, now)}</span>}
          </button> : <p className="attention-action">
            <span className="attention-action-label">{action?.label || entry?.activity || 'Working'}</span>
            {actions.length > 1 && <small>+{actions.length - 1} parallel</small>}
            {action?.since !== undefined && <span className="attention-clock" aria-label="Action elapsed">{elapsed(action.since, now)}</span>}
          </p>}
          {entry?.historyError && <LoadFailed onRetry={() => void useAttention.getState().refresh([s])}>{failedTo('load activity', entry.historyError)}</LoadFailed>}
        </article>
      })}
      {sessionsStatus === 'ready' && visible.length === 0 && <p className="attention-empty">No active tasks or new results</p>}
    </section>
    {!standalone && <footer>Keep the main go-chamber tab open to receive updates.</footer>}
  </section>
}
