import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PictureInPicture2 } from 'lucide-react'
import { sessionTitle } from '../../lib/sessions'
import { basename } from '../../lib/format'
import { brief, elapsed, useAttention } from '../../stores/attention'
import { useSessionStore } from '../../stores/session'
import { useLayoutStore } from '../../stores/layout'
import RequestTray from '../requests/RequestTray'
import './AttentionWindow.css'

interface PictureInPictureAPI {
  requestWindow(options: { width: number; height: number }): Promise<Window>
}

export default function AttentionWindow() {
  const api = (window as Window & { documentPictureInPicture?: PictureInPictureAPI }).documentPictureInPicture
  const [child, setChild] = useState<Window | null>(null)
  const [error, setError] = useState('')
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
    setError('')
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
      if (mounted.current) setError(err instanceof Error ? err.message : 'Could not open the floating panel')
    } finally {
      busy.current = false
      if (mounted.current) setOpening(false)
    }
  }
  return <>
    <button type="button" className="btn btn-ghost btn-icon" aria-label="Open floating panel"
      aria-pressed={!!child} aria-busy={opening || undefined} disabled={!api || opening}
      title={api ? 'Floating panel · keep agents visible above other apps' : 'Floating panel requires desktop Chrome or Edge (HTTPS or localhost)'}
      onClick={() => void open()}><PictureInPicture2 size={16} /></button>
    {error && <span className="error" role="alert">{error}</span>}
    {child && createPortal(<AttentionPanel />, child.document.body)}
  </>
}

export function AttentionPanel({ standalone = false }: { standalone?: boolean }) {
  const sessions = useSessionStore((s) => s.sessions)
  const requests = useSessionStore((s) => s.pendingRequests)
  const connection = useSessionStore((s) => s.connection)
  const sessionsStatus = useSessionStore((s) => s.sessionsStatus)
  const select = useSessionStore((s) => s.selectSession)
  const entries = useAttention((s) => s.entries)
  const dismiss = useAttention((s) => s.dismiss)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const refreshKey = sessions.map((s) => `${s.id}:${s.status}:${s.activeAt}`).join('|')
  useEffect(() => {
    if (connection === 'online') void useAttention.getState().refresh(useSessionStore.getState().sessions)
  }, [connection, refreshKey])
  const running = sessions.filter((s) => !s.parentId && s.status === 'running')
  const visible = sessions.filter((s) => !s.parentId && (s.status === 'running' || (entries[s.id]?.outcome && !entries[s.id]?.dismissed)))
  const priority = (id: string) => requests.some((r) => r.sessionId === id) ? 0 : entries[id]?.outcome === 'Failed' ? 1 : entries[id]?.outcome ? 3 : 2
  visible.sort((a, b) => priority(a.id) - priority(b.id))
  const returnToChat = () => {
    useLayoutStore.getState().setMode('agents')
    if (!standalone) window.focus()
  }
  return <section className={standalone ? "attention-panel attention-overview" : "attention-panel"} aria-label={standalone ? "Overview" : "Floating activity"}>
    <header>{standalone ? <h2>Overview</h2> : <strong>go-chamber</strong>}<button className="btn btn-xs" onClick={() => { useSessionStore.getState().setPane(standalone ? 'sessions' : 'chat'); returnToChat() }}>{standalone ? 'Sessions' : 'Open workspace'}</button></header>
    <p className="attention-summary">{running.length} running · {requests.length} waiting</p>
    {connection !== 'online' && <p role="status">Updates paused · {standalone ? 'reconnecting' : 'reconnecting in the main tab'}</p>}
    <div onClick={(event) => {
      // RequestTray navigates questions and interrupted sessions in the main app.
      // Use the child's DOM realm: instanceof HTMLElement would reject its nodes.
      const target = event.target as Element
      if (target.closest('.tray-row')) returnToChat()
    }}><RequestTray /></div>
    <section aria-label="Session activity">
      <h2 className="section-title">Session activity</h2>
      {sessionsStatus !== 'ready' && <p>Session list {sessionsStatus === 'error' ? 'unavailable — retry in the workspace' : 'loading…'}</p>}
      {visible.map((s) => {
        const entry = entries[s.id]
        const done = !!entry?.outcome && s.status !== 'running'
        const pending = requests.filter((r) => r.sessionId === s.id)
        const waits = pending.map((r) => entry?.waiting[r.id]).filter((at): at is number => at !== undefined)
        const waitSince = waits.length ? Math.min(...waits) : undefined
        const actions = Object.values(entry?.actions || {})
        const action = actions[actions.length - 1]
        const fallbackStart = s.activeAt ? Date.parse(s.activeAt) : NaN
        const start = entry?.startedAt ?? (Number.isFinite(fallbackStart) ? fallbackStart : undefined)
        const clock = done && entry?.endedAt === undefined ? '—' : elapsed(start, done ? entry!.endedAt! : now)
        return <article className="attention-session" key={s.id} data-outcome={done ? entry?.outcome : undefined}>
          <div className="attention-session-head"><span>{basename(s.cwd)} · {s.agent}</span><span aria-label="Task elapsed" title={done ? 'Task duration' : 'Time since the task started'}>{clock}</span></div>
          <button className="attention-task" title={sessionTitle(s)} onClick={() => { void select(s.id); returnToChat() }}>{entry?.summary || brief(sessionTitle(s), 8)}</button>
          {done ? <>
            <strong className="attention-outcome">{entry?.outcome}</strong>
            {entry?.result && <p className="attention-result">{entry.result}</p>}
            <div className="attention-result-actions">
              <button className="btn btn-xs" onClick={() => { void select(s.id); returnToChat() }}>Open result</button>
              <button className="btn btn-xs btn-ghost" aria-label="Dismiss result" onClick={() => dismiss(s.id)}>Dismiss</button>
            </div>
          </> : pending.length ? <p className="attention-waiting">Waiting for you{waitSince !== undefined ? ` · ${elapsed(waitSince, now)}` : ''}</p> : <p className="attention-action">
            <span>{action?.label || entry?.activity || 'Working'}</span>
            {action?.since !== undefined && <span aria-label="Action elapsed">{elapsed(action.since, now)}</span>}
            {actions.length > 1 && <small>+{actions.length - 1} parallel</small>}
          </p>}
          {entry?.historyError && <p className="error">Activity unavailable. <button className="btn btn-xs" onClick={() => void useAttention.getState().refresh([s])}>Retry</button></p>}
        </article>
      })}
      {sessionsStatus === 'ready' && visible.length === 0 && <p>No active tasks or new results</p>}
    </section>
    {!standalone && <footer>Keep the main go-chamber tab open to receive updates.</footer>}
  </section>
}
