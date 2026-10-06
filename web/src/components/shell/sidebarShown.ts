import { CROWDED, sidebarShown, useLayoutStore, visibleDock } from '../../stores/layout'
import { useSessionStore } from '../../stores/session'
import { useMedia } from '../chat/useMedia'
import { useWaitingCount } from '../../lib/waiting'

// useSidebarShown says whether the sessions list is on screen: where the
// window is crowded, an open dock takes its place.
export function useSidebarShown(): boolean {
  const crowded = useMedia(CROWDED)
  const sidebar = useLayoutStore((s) => s.sidebar)
  const focus = useLayoutStore((s) => s.focus)
  const dock = useLayoutStore((s) => s.dock)
  const layout = { sidebar, focus, dock }
  const pending = useWaitingCount()
  const hasSession = useSessionStore((s) => Boolean(s.activeId))
  return sidebarShown(layout, visibleDock(layout, pending, hasSession), crowded)
}
