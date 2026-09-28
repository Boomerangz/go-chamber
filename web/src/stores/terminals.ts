import { create } from 'zustand'
import {
  closeTerminal,
  renameTerminal,
  listTerminals,
  openTerminal,
  type OpenTerminalOptions,
  type Terminal,
} from '../lib/terminal'

interface TerminalState {
  terminals: Terminal[]
  activeId: string | null
  // focusId is the terminal the user just opened or selected; only it takes
  // keyboard focus, so a page load doesn't steal typing from the composer.
  focusId: string | null
  error: string | null
  load: () => Promise<void>
  open: (opts: OpenTerminalOptions) => Promise<void>
  close: (id: string) => Promise<void>
  select: (id: string) => void
  rename: (id: string, title: string) => Promise<void>
  markExited: (id: string, code: number) => void
}

const initial = {
  terminals: [] as Terminal[],
  activeId: null as string | null,
  focusId: null as string | null,
  error: null as string | null,
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

const STORAGE_KEY = 'go-chamber.terminal'

// The selection is remembered per browser tab so a reload reattaches to the
// same terminal. Nothing is opened unasked: every attached view answers the
// shell's terminal queries, so extra viewers would type duplicate answers.
function remembered(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function remember(id: string | null) {
  try {
    if (id) sessionStorage.setItem(STORAGE_KEY, id)
    else sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // storage unavailable: the selection just won't survive a reload
  }
}

const exists = (terminals: Terminal[], id: string | null) => id !== null && terminals.some((t) => t.id === id)

// keepActive keeps the selection if it still exists, else picks the first.
function keepActive(terminals: Terminal[], activeId: string | null): string | null {
  if (exists(terminals, activeId)) return activeId
  return terminals[0]?.id ?? null
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  ...initial,
  load: async () => {
    try {
      const before = new Set(get().terminals.map((t) => t.id))
      const listed = await listTerminals()
      // Keep terminals opened while the list was in flight.
      const known = new Set(listed.map((t) => t.id))
      const opened = get().terminals.filter((t) => !before.has(t.id) && !known.has(t.id))
      const terminals = [...listed, ...opened]
      const current = get().activeId ?? remembered()
      set({ terminals, activeId: exists(terminals, current) ? current : null, error: null })
    } catch (err) {
      set({ error: message(err) })
    }
  },
  open: async (opts) => {
    try {
      const term = await openTerminal(opts)
      remember(term.id)
      set((s) => ({ terminals: [...s.terminals, term], activeId: term.id, focusId: term.id, error: null }))
    } catch (err) {
      set({ error: message(err) })
    }
  },
  close: async (id) => {
    try {
      await closeTerminal(id)
      set((s) => {
        const terminals = s.terminals.filter((t) => t.id !== id)
        const activeId = keepActive(terminals, s.activeId)
        remember(activeId)
        return { terminals, activeId, error: null }
      })
    } catch (err) {
      set({ error: message(err) })
    }
  },
  rename: async (id, title) => {
    try {
      const renamed = await renameTerminal(id, title)
      set((s) => ({ terminals: s.terminals.map((t) => (t.id === id ? renamed : t)), error: null }))
    } catch (err) {
      set({ error: message(err) })
    }
  },
  select: (id) => {
    remember(id)
    set({ activeId: id, focusId: id })
  },
  markExited: (id, code) =>
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, status: 'exited', exitCode: code } : t)),
    })),
}))

export function resetTerminals() {
  useTerminalStore.setState(initial)
}
