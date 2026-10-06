import { useCallback, useEffect, useRef, useState } from 'react'
import DiagnosticsPage from './components/diagnostics/DiagnosticsPage'
import { monitorBrowser } from './lib/diagnostics'
import DiffPanel from './components/changes/DiffPanel'
import Chat from './components/chat/Chat'
import EmptyChat from './components/chat/EmptyChat'
import NotifyToggle from './components/notify/NotifyToggle'
import SoundToggle from './components/notify/SoundToggle'
import RequestTray from './components/requests/RequestTray'
import Sidebar from './components/sessions/Sidebar'
import { DockRail, HealthStatus, ModeSwitch, PaneBar, SignOut } from './components/shell/Shell'
import Notices from './components/shell/Notices'
import Hotkeys from './components/shell/Hotkeys'
import { openShortcuts } from './components/shell/overlay'
import { useRouteSync } from './components/shell/routeSync'
import { LoadingLine } from './components/ui/Loading'
import TerminalPanel from './components/terminal/TerminalPanel'
import TerminalWorkspace from './components/terminal/TerminalWorkspace'
import { fetchHealth, UNAUTHORIZED_EVENT, type Health } from './lib/api'
import { setAttentionIcon } from './lib/favicon'
import { usePending } from './lib/pending'
import { sessionTitle } from './lib/sessions'
import { attentionTitle } from './lib/title'
import { endedTurns, markEnded, markVisited, unseenCount, useVisits } from './lib/visits'
import { useLayoutStore, visibleDock } from './stores/layout'
import { useSessionStore } from './stores/session'
import { useTerminalStore } from './stores/terminals'

export default function App() {
  const [health, retryHealth] = useHealth()
  const sessions = useSessionStore((s) => s.sessions)
  const activeId = useSessionStore((s) => s.activeId)
  const pane = useSessionStore((s) => s.pane)
  const loadSessions = useSessionStore((s) => s.loadSessions)
  const loadRequests = useSessionStore((s) => s.loadRequests)
  const loadQuotas = useSessionStore((s) => s.loadQuotas)
  const connect = useSessionStore((s) => s.connect)
  const createSession = useSessionStore((s) => s.createSession)
  const mode = useLayoutStore((s) => s.mode)
  const focus = useLayoutStore((s) => s.focus)
  const toggleFocus = useLayoutStore((s) => s.toggleFocus)
  const pending = useSessionStore((s) => s.pendingRequests.length)
  const chosenDock = useLayoutStore((s) => s.dock)
  const dock = visibleDock({ dock: chosenDock, focus }, pending)
  const loadTerminals = useTerminalStore((s) => s.load)

  useAttentionTitle()
  useVisitMarks()
  const [tryNow, trying] = usePending(retryHealth)

  useEffect(() => {
    if (health === 'online') {
      void loadSessions()
      void loadRequests()
      void loadQuotas()
      void loadTerminals()
      connect()
    }
  }, [health, loadSessions, loadRequests, loadQuotas, loadTerminals, connect])

  useEffect(() => monitorBrowser(), [])

  useRouteSync(health === 'online')

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <h1>go-chamber</h1>
        </div>
        {health === 'online' && <ModeSwitch />}
        <div className="topbar-end">
          <HealthStatus health={health} />
          {health === 'online' && mode === 'agents' && (
            <button
              type="button"
              className="btn btn-ghost focus-toggle"
              aria-pressed={focus}
              title={focus ? 'Show sessions and dock (f)' : 'Only the chat, until an agent needs you (f)'}
              onClick={toggleFocus}
            >
              Focus
            </button>
          )}
          {health === 'online' && <NotifyToggle />}
          {health === 'online' && <SoundToggle />}
          {health === 'online' && (
            <button
              type="button"
              className="btn btn-ghost btn-icon shortcuts-help"
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts (?)"
              onClick={openShortcuts}
            >
              ?
            </button>
          )}
          {health === 'online' && <SignOut className="signout" />}
        </div>
      </header>
      {health === 'unauthorized' && (
        <section className="notice panel">
          <h2>Signed out</h2>
          <p>
            <a href="/">Sign in</a> with the access token go-chamber printed at startup.
          </p>
        </section>
      )}
      {health === null && (
        <section className="notice">
          <LoadingLine>connecting to go-chamber…</LoadingLine>
        </section>
      )}
      {health === 'offline' && (
        <section className="notice panel">
          <h2>go-chamber isn't reachable</h2>
          <p>The server may be restarting. This page reconnects on its own as soon as it answers.</p>
          <p>
            <button type="button" className="btn" aria-busy={trying || undefined} onClick={() => void tryNow()}>
              {trying ? 'Trying…' : 'Try now'}
            </button>
          </p>
        </section>
      )}
      {health === 'online' && mode === 'diagnostics' && <DiagnosticsPage />}
      {health === 'online' && mode === 'terminal' && (
        <div className="layout term-layout">
          <TerminalWorkspace sessions={sessions} />
        </div>
      )}
      {health === 'online' && mode === 'agents' && (
        <>
          <div className="layout" data-pane={pane} data-dock={dock ?? 'closed'} data-focus={focus ? 'on' : undefined}>
            <Sidebar sessions={sessions} onCreate={(agent, cwd, branch) => createSession(agent, cwd, branch)} />
            {activeId ? <Chat key={activeId} /> : <EmptyChat />}
            <div className="dock">
              {dock && (
                <div className="dock-body">
                  {dock === 'requests' ? (
                    <RequestTray />
                  ) : dock === 'changes' ? (
                    <DiffPanel key={activeId} sessionId={activeId} />
                  ) : (
                    <TerminalPanel sessionId={activeId} />
                  )}
                </div>
              )}
              <DockRail />
            </div>
            <div className="requests-pane">
              <RequestTray />
            </div>
            <div className="changes-pane">{pane === 'changes' && <DiffPanel key={activeId} sessionId={activeId} />}</div>
          </div>
          <PaneBar />
        </>
      )}
      <Notices />
      {health === 'online' && <Hotkeys />}
    </main>
  )
}

const HEALTH_RETRY_MS = [1000, 2000, 5000, 10_000]

// useHealth asks the server whether it is up and keeps asking while it isn't:
// a page opened during a restart recovers without a reload. It also asks
// again at once when the device wakes or the network returns.
function useHealth(): [Health | null, () => Promise<void>] {
  const [health, setHealth] = useState<Health | null>(null)
  const attempt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const check = useCallback(function check(): Promise<void> {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    return fetchHealth().then((h) => {
      setHealth(h)
      if (h === 'offline') {
        const delay = HEALTH_RETRY_MS[Math.min(attempt.current++, HEALTH_RETRY_MS.length - 1)]
        timer.current = setTimeout(check, delay)
      } else {
        attempt.current = 0
      }
    })
  }, [])
  useEffect(() => {
    void check()
    const wake = () => {
      if (document.visibilityState !== 'hidden' && timer.current) {
        attempt.current = 0
        void check()
      }
    }
    const signedOut = () => setHealth('unauthorized')
    window.addEventListener('online', wake)
    window.addEventListener(UNAUTHORIZED_EVENT, signedOut)
    document.addEventListener('visibilitychange', wake)
    return () => {
      if (timer.current) clearTimeout(timer.current)
      window.removeEventListener('online', wake)
      window.removeEventListener(UNAUTHORIZED_EVENT, signedOut)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [check])
  const retry = useCallback(() => {
    attempt.current = 0
    return check()
  }, [check])
  return [health, retry]
}

// useAttentionTitle keeps the tab title and icon saying what needs the owner.
function useAttentionTitle() {
  const pending = useSessionStore((s) => s.pendingRequests.length)
  const running = useSessionStore((s) => s.sessions.some((x) => x.status === 'running'))
  const session = useSessionStore((s) => {
    const active = s.sessions.find((x) => x.id === s.activeId)
    return active ? sessionTitle(active) : undefined
  })
  const visits = useVisits()
  const unseen = useSessionStore((s) => unseenCount(s.sessions, visits, s.activeId))
  useEffect(() => {
    document.title = attentionTitle({ pending, running, session, unseen })
    setAttentionIcon(pending > 0)
  }, [pending, running, session, unseen])
}

// useVisitMarks records that the open session has been seen as it is now,
// so the list marks only what changed while the owner looked elsewhere.
// A turn that ends in another session is marked as changed while away.
function useVisitMarks() {
  const active = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeId))
  useEffect(() => {
    if (active) markVisited(active)
  }, [active])
  useEffect(
    () =>
      useSessionStore.subscribe((now, before) => {
        if (now.sessions === before.sessions) return
        for (const id of endedTurns(before.sessions, now.sessions)) if (id !== now.activeId) markEnded(id)
      }),
    [],
  )
}
