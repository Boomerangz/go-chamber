import type { CSSProperties } from 'react'
import { create } from 'zustand'
import { useSessionStore } from './session'

// Mode is the workspace: agent sessions, or terminals on their own.
export type Mode = 'agents' | 'terminal' | 'diagnostics'

// Dock is the side panel next to the chat; null when collapsed to its rail.
export type Dock = 'requests' | 'terminal' | 'changes' | null
export type DockTab = Exclude<Dock, null>

// Widths the owner can drag a dock and the sidebar to, in pixels.
export const DOCK_MIN = 280
export const DOCK_MAX = 1400
export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 480

interface Layout {
  mode: Mode
  dock: Dock
  // focus leaves only the chat on screen until an agent needs the owner.
  focus: boolean
  // wrap folds long lines in diffs and the file viewer.
  wrap: boolean
  // widths is each dock's dragged width; a missing one takes the default.
  widths: Partial<Record<DockTab, number>>
  // sidebarWidth is the dragged sessions sidebar width, null for the default.
  sidebarWidth: number | null
  // sidebar is false while the sessions sidebar is hidden.
  sidebar: boolean
}

interface LayoutStore extends Layout {
  setMode: (mode: Mode) => void
  // toggleDock opens a dock tab, or collapses the dock when it is open.
  toggleDock: (tab: DockTab) => void
  toggleFocus: () => void
  toggleWrap: () => void
  // setDockWidth remembers a dock's width; null goes back to the default.
  setDockWidth: (tab: DockTab, px: number | null) => void
  setSidebarWidth: (px: number | null) => void
  toggleSidebar: () => void
}

const KEY = 'gc.layout'
const tabs: DockTab[] = ['requests', 'terminal', 'changes']

const clamp = (px: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, px)))

function readWidths(raw: unknown): Layout['widths'] {
  const widths: Layout['widths'] = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return widths
  for (const tab of tabs) {
    const px = (raw as Record<string, unknown>)[tab]
    if (typeof px === 'number' && Number.isFinite(px)) widths[tab] = clamp(px, DOCK_MIN, DOCK_MAX)
  }
  return widths
}

const defaults: Layout = { mode: 'agents', dock: null, focus: false, wrap: false, widths: {}, sidebarWidth: null, sidebar: true }

export function loadLayout(): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>
    return {
      mode: raw.mode === 'terminal' || raw.mode === 'diagnostics' ? raw.mode : 'agents',
      dock: raw.dock === 'requests' || raw.dock === 'terminal' || raw.dock === 'changes' ? raw.dock : null,
      focus: raw.focus === true,
      wrap: raw.wrap === true,
      widths: readWidths(raw.widths),
      sidebarWidth: typeof raw.sidebarWidth === 'number' && Number.isFinite(raw.sidebarWidth) ? clamp(raw.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX) : null,
      sidebar: raw.sidebar !== false,
    }
  } catch {
    return { ...defaults }
  }
}

function save(layout: Layout) {
  const { mode, dock, focus, wrap, widths, sidebarWidth, sidebar } = layout
  try {
    localStorage.setItem(KEY, JSON.stringify({ mode, dock, focus, wrap, widths, sidebarWidth, sidebar }))
  } catch {
    // storage unavailable: the layout lasts for this page only
  }
}

// visibleDock is the dock actually shown: in focus only the requests tray,
// and only while requests wait. Changes need a session; without one the
// dock stays on its rail.
export function visibleDock(layout: Pick<Layout, 'dock' | 'focus'>, pending: number, hasSession = true): Dock {
  if (layout.focus) return pending > 0 ? 'requests' : null
  if (layout.dock === 'changes' && !hasSession) return null
  return layout.dock
}

// CROWDED is a window too narrow for the sessions list, the chat and an open
// dock side by side (above the phone layout, which shows one pane at a time).
// There an open dock takes the sessions list's place: one side panel at a time.
export const CROWDED = '(min-width: 721px) and (max-width: 1100px)'

const crowdedNow = () => typeof window !== 'undefined' && !!window.matchMedia?.(CROWDED).matches

// sidebarShown says whether the sessions list is on screen: shown by the
// owner, and not crowded out by the open dock (dock is the visible one).
export function sidebarShown(layout: Pick<Layout, 'sidebar' | 'focus'>, dock: Dock, crowded: boolean): boolean {
  return layout.sidebar && !layout.focus && !(crowded && dock !== null)
}

export const useLayoutStore = create<LayoutStore>((set, get) => {
  const update = (patch: Partial<Layout>) => {
    set(patch)
    save(get())
  }
  return {
    ...loadLayout(),
    setMode: (mode) => update({ mode }),
    toggleDock: (tab) => {
      if (get().dock === tab) return update({ dock: null })
      // Changes are a session's: without one there is nothing to open.
      if (tab === 'changes' && !useSessionStore.getState().activeId) return
      update({ dock: tab })
    },
    toggleFocus: () => update({ focus: !get().focus }),
    toggleWrap: () => update({ wrap: !get().wrap }),
    setDockWidth: (tab, px) => {
      const widths = { ...get().widths }
      if (px === null) delete widths[tab]
      else widths[tab] = clamp(px, DOCK_MIN, DOCK_MAX)
      update({ widths })
    },
    setSidebarWidth: (px) => update({ sidebarWidth: px === null ? null : clamp(px, SIDEBAR_MIN, SIDEBAR_MAX) }),
    toggleSidebar: () => {
      const layout = get()
      // Crowded out by the dock: bringing the sessions back collapses the dock.
      if (layout.sidebar && crowdedNow()) {
        const { pendingRequests, activeId } = useSessionStore.getState()
        if (visibleDock(layout, pendingRequests.length, Boolean(activeId))) return update({ dock: null })
      }
      update({ sidebar: !layout.sidebar })
    },
  }
})

// useLayoutVars is the grid's dragged widths, as CSS variables: the open
// dock's and the sidebar's. Without them each takes its default width.
export function useLayoutVars(dock: Dock): CSSProperties {
  const dockWidth = useLayoutStore((s) => (dock ? s.widths[dock] : undefined))
  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth)
  const vars: Record<string, string> = {}
  if (dockWidth) vars['--dock-w'] = `${dockWidth}px`
  if (sidebarWidth) vars['--sidebar-w'] = `${sidebarWidth}px`
  return vars as CSSProperties
}

// settled is set once the first list of requests has been seen this page.
let settled = false

// settleRestoredDock runs once, when the first list of requests arrives: a
// Requests dock restored from the last visit collapses to its rail when
// nothing waits, rather than opening on an empty tray.
export function settleRestoredDock(pending: number) {
  if (settled) return
  settled = true
  const layout = useLayoutStore.getState()
  if (layout.dock === 'requests' && pending === 0) useLayoutStore.setState({ dock: null })
}

export function resetLayout() {
  settled = false
  useLayoutStore.setState(loadLayout())
}
