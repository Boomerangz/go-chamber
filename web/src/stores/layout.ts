import { create } from 'zustand'

// Mode is the workspace: agent sessions, or terminals on their own.
export type Mode = 'agents' | 'terminal' | 'diagnostics'

// Dock is the side panel next to the chat; null when collapsed to its rail.
export type Dock = 'requests' | 'terminal' | 'changes' | null

interface Layout {
  mode: Mode
  dock: Dock
  // focus leaves only the chat on screen until an agent needs the owner.
  focus: boolean
}

interface LayoutStore extends Layout {
  setMode: (mode: Mode) => void
  // toggleDock opens a dock tab, or collapses the dock when it is open.
  toggleDock: (tab: Exclude<Dock, null>) => void
  toggleFocus: () => void
}

const KEY = 'gc.layout'

export function loadLayout(): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Layout>
    return {
      mode: raw.mode === 'terminal' || raw.mode === 'diagnostics' ? raw.mode : 'agents',
      dock: raw.dock === 'requests' || raw.dock === 'terminal' || raw.dock === 'changes' ? raw.dock : null,
      focus: raw.focus === true,
    }
  } catch {
    return { mode: 'agents', dock: null, focus: false }
  }
}

function save(layout: Layout) {
  try {
    localStorage.setItem(KEY, JSON.stringify(layout))
  } catch {
    // storage unavailable: the layout lasts for this page only
  }
}

// visibleDock is the dock actually shown: in focus only the requests tray,
// and only while requests wait.
export function visibleDock(layout: Pick<Layout, 'dock' | 'focus'>, pending: number): Dock {
  if (!layout.focus) return layout.dock
  return pending > 0 ? 'requests' : null
}

export const useLayoutStore = create<LayoutStore>((set, get) => ({
  ...loadLayout(),
  setMode: (mode) => {
    set({ mode })
    save({ mode, dock: get().dock, focus: get().focus })
  },
  toggleDock: (tab) => {
    const dock = get().dock === tab ? null : tab
    set({ dock })
    save({ mode: get().mode, dock, focus: get().focus })
  },
  toggleFocus: () => {
    const focus = !get().focus
    set({ focus })
    save({ mode: get().mode, dock: get().dock, focus })
  },
}))

export function resetLayout() {
  useLayoutStore.setState(loadLayout())
}
