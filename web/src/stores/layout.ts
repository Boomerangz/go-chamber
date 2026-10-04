import { create } from 'zustand'

// Mode is the workspace: agent sessions, or terminals on their own.
export type Mode = 'agents' | 'terminal' | 'diagnostics'

// Dock is the side panel next to the chat; null when collapsed to its rail.
export type Dock = 'requests' | 'terminal' | 'changes' | null

interface Layout {
  mode: Mode
  dock: Dock
}

interface LayoutStore extends Layout {
  setMode: (mode: Mode) => void
  // toggleDock opens a dock tab, or collapses the dock when it is open.
  toggleDock: (tab: Exclude<Dock, null>) => void
}

const KEY = 'gc.layout'

export function loadLayout(): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Layout>
    return {
      mode: raw.mode === 'terminal' || raw.mode === 'diagnostics' ? raw.mode : 'agents',
      dock: raw.dock === 'requests' || raw.dock === 'terminal' || raw.dock === 'changes' ? raw.dock : null,
    }
  } catch {
    return { mode: 'agents', dock: null }
  }
}

function save(layout: Layout) {
  try {
    localStorage.setItem(KEY, JSON.stringify(layout))
  } catch {
    // storage unavailable: the layout lasts for this page only
  }
}

export const useLayoutStore = create<LayoutStore>((set, get) => ({
  ...loadLayout(),
  setMode: (mode) => {
    set({ mode })
    save({ mode, dock: get().dock })
  },
  toggleDock: (tab) => {
    const dock = get().dock === tab ? null : tab
    set({ dock })
    save({ mode: get().mode, dock })
  },
}))

export function resetLayout() {
  useLayoutStore.setState(loadLayout())
}
