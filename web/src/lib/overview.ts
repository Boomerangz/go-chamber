import { useLayoutStore } from '../stores/layout'
import { useSessionStore } from '../stores/session'

// overviewShown tells whether the Overview stands in the workspace's place.
export function overviewShown(): boolean {
  return useLayoutStore.getState().mode === 'agents' && useSessionStore.getState().pane === 'overview'
}

// leaveOverview brings the workspace back: the open chat, else the list.
export function leaveOverview(): void {
  const { pane, activeId, setPane } = useSessionStore.getState()
  if (pane === 'overview') setPane(activeId ? 'chat' : 'sessions')
}

// toggleOverview shows the Overview, or leaves it when it shows.
export function toggleOverview(): void {
  if (overviewShown()) {
    leaveOverview()
    return
  }
  useSessionStore.getState().setPane('overview')
  useLayoutStore.getState().setMode('agents')
}

// inWorkspace runs a workspace shortcut (focus, a dock, the next session)
// from the Overview too: it brings the workspace back first, and waits a
// frame for it to render when the shortcut acts on what is on screen.
export function inWorkspace(run: () => void, afterRender = false): void {
  if (!overviewShown()) {
    run()
    return
  }
  leaveOverview()
  if (afterRender) requestAnimationFrame(run)
  else run()
}
