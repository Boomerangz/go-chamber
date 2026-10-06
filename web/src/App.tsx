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
import { DockRail, DockSplitter, HealthStatus, ModeSwitch, PaneBar, SidebarSplitter } from './components/shell/Shell'
import Notices from './components/shell/Notices'
import Hotkeys from './components/shell/Hotkeys'
import TerminalPanel from './components/terminal/TerminalPanel'
import TerminalWorkspace from './components/terminal/TerminalWorkspace'
import { fetchHealth, UNAUTHORIZED_EVENT, type Health } from './lib/api'
import { parseRoute, routePath } from './lib/route'
import { sessionTitle } from './lib/sessions'
import { attentionTitle } from './lib/title'
import { useLayoutStore, useLayoutVars, visibleDock } from './stores/layout'
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
  const dock = visibleDock({ dock: chosenDock, focus }, pending, Boolean(activeId))
  const sidebar = useLayoutStore((s) => s.sidebar)
  const layoutVars = useLayoutVars(dock)
  const loadTerminals = useTerminalStore((s) => s.load)

  useAttentionTitle()

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
              title={focus ? 'Show sessions and dock' : 'Only the chat, until an agent needs you'}
              onClick={toggleFocus}
            >
              Focus
            </button>
          )}
          {health === 'online' && <NotifyToggle />}
          {health === 'online' && <SoundToggle />}
          {health === 'online' && (
            <form method="post" action="/logout" className="signout">
              <button type="submit" className="btn btn-ghost">Sign out</button>
            </form>
          )}
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
      {health === 'offline' && (
        <section className="notice panel">
          <h2>go-chamber isn't reachable</h2>
          <p>The server may be restarting. This page reconnects on its own as soon as it answers.</p>
          <p>
            <button type="button" className="btn" onClick={retryHealth}>
              Try now
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
          <div className="layout" data-pane={pane} data-dock={dock ?? 'closed'} data-focus={focus ? 'on' : undefined} data-sidebar={sidebar ? undefined : 'off'} style={layoutVars}>
            <Sidebar sessions={sessions} onCreate={(agent, cwd, branch) => createSession(agent, cwd, branch)} />
            <SidebarSplitter />
            {activeId ? <Chat key={activeId} /> : <EmptyChat />}
            <div className="dock">
              {dock && <DockSplitter dock={dock} />}
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
            <div className="requests-pane">{pane === 'requests' && <RequestTray />}</div>
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
function useHealth(): [Health | null, () => void] {
  const [health, setHealth] = useState<Health | null>(null)
  const attempt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const check = useCallback(function check() {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    void fetchHealth().then((h) => {
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
    check()
    const wake = () => {
      if (document.visibilityState !== 'hidden' && timer.current) {
        attempt.current = 0
        check()
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
    check()
  }, [check])
  return [health, retry]
}

// useAttentionTitle keeps the tab title saying what needs the owner.
function useAttentionTitle() {
  const pending = useSessionStore((s) => s.pendingRequests.length)
  const running = useSessionStore((s) => s.sessions.some((x) => x.status === 'running'))
  const session = useSessionStore((s) => {
    const active = s.sessions.find((x) => x.id === s.activeId)
    return active ? sessionTitle(active) : undefined
  })
  useEffect(() => {
    document.title = attentionTitle({ pending, running, session })
  }, [pending, running, session])
}

// useRouteSync keeps the URL on the open session (/s/<id>) or terminal
// (/t/<id>): a reload or a shared link reopens it, and Back returns to the
// previous one.
function useRouteSync(online: boolean) {
  useEffect(() => {
    if (!online) return
    const apply = () => {
      const route = parseRoute(location.pathname)
      if (route.kind === 'diagnostics') {
        useLayoutStore.getState().setMode('diagnostics')
      } else if (route.kind === 'session') {
        useLayoutStore.getState().setMode('agents')
        if (useSessionStore.getState().activeId !== route.id) void useSessionStore.getState().selectSession(route.id)
      } else if (route.kind === 'terminal') {
        useLayoutStore.getState().setMode('terminal')
        useTerminalStore.getState().select(route.id)
      }
    }
    const current = () =>
      routePath(useLayoutStore.getState().mode, useSessionStore.getState().activeId, useTerminalStore.getState().activeId)
    let navigating = false
    // Preserve session/terminal URLs when closing their views, but allow an
    // empty workspace to leave diagnostics and return with browser Back.
    const follow = () => {
      if (navigating) return
      const path = current()
      if ((path !== '/' || parseRoute(location.pathname).kind === 'diagnostics') && path !== location.pathname) history.pushState(null, '', path + location.search)
    }
    apply()
    if (current() !== '/' && current() !== location.pathname) history.replaceState(null, '', current() + location.search)
    const unsubscribe = [useLayoutStore.subscribe(follow), useSessionStore.subscribe(follow), useTerminalStore.subscribe(follow)]
    const onPop = () => {
      navigating = true
      try {
        if (location.pathname === '/') useLayoutStore.getState().setMode('agents')
        else apply()
      } finally { navigating = false }
    }
    window.addEventListener('popstate', onPop)
    return () => {
      unsubscribe.forEach((u) => u())
      window.removeEventListener('popstate', onPop)
    }
  }, [online])
}
