import { useEffect } from 'react'
import { parseRoute, routePath } from '../../lib/route'
import { useLayoutStore } from '../../stores/layout'
import { useSessionStore, type Pane } from '../../stores/session'
import { useTerminalStore } from '../../stores/terminals'

const NARROW = '(max-width: 720px)'

function narrow(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(NARROW).matches
}

let replacing = false

// replacingHistory runs a navigation that should not add a Back step, such
// as stepping through sessions with j/k.
export function replacingHistory(run: () => void): void {
  replacing = true
  try {
    run()
  } finally {
    replacing = false
  }
}

interface Entry {
  pane?: Pane
}

// useRouteSync keeps the URL on the open session (/s/<id>) or terminal
// (/t/<id>): a reload or a shared link reopens it, and Back returns to the
// previous one. On phones, where one pane shows at a time, opening a chat
// from the sessions list is a step of its own: Back returns to the list.
export function useRouteSync(online: boolean): void {
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
    const pane = () => useSessionStore.getState().pane
    let navigating = false
    let lastPane = pane()
    // Preserve session/terminal URLs when closing their views, but allow an
    // empty workspace to leave diagnostics and return with browser Back.
    const follow = () => {
      if (navigating) return
      const path = current()
      const now = pane()
      const entry: Entry = { pane: now }
      if ((path !== '/' || parseRoute(location.pathname).kind === 'diagnostics') && path !== location.pathname) {
        if (replacing) history.replaceState(entry, '', path + location.search)
        else history.pushState(entry, '', path + location.search)
      } else if (now !== lastPane) {
        const here = location.pathname + location.search
        if (narrow() && lastPane === 'sessions' && now === 'chat' && !replacing) history.pushState(entry, '', here)
        else history.replaceState(entry, '', here)
      }
      lastPane = now
    }
    apply()
    lastPane = pane()
    if (current() !== '/' && current() !== location.pathname) history.replaceState({ pane: pane() }, '', current() + location.search)
    const unsubscribe = [useLayoutStore.subscribe(follow), useSessionStore.subscribe(follow), useTerminalStore.subscribe(follow)]
    const onPop = (e: PopStateEvent) => {
      navigating = true
      try {
        const entry = (e.state ?? {}) as Entry
        if (narrow() && entry.pane === 'sessions' && parseRoute(location.pathname).kind === 'session') {
          // Back from a chat to the list: the chat stays open behind it.
          useLayoutStore.getState().setMode('agents')
          useSessionStore.getState().setPane('sessions')
          const path = current()
          if (path !== location.pathname) history.replaceState({ pane: 'sessions' }, '', path + location.search)
        } else if (location.pathname === '/') useLayoutStore.getState().setMode('agents')
        else {
          apply()
          if (narrow() && entry.pane && parseRoute(location.pathname).kind === 'session') useSessionStore.getState().setPane(entry.pane)
        }
      } finally {
        navigating = false
        lastPane = pane()
      }
    }
    window.addEventListener('popstate', onPop)
    return () => {
      unsubscribe.forEach((u) => u())
      window.removeEventListener('popstate', onPop)
    }
  }, [online])
}
