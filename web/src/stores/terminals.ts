import { create } from 'zustand'
import { LiveList } from '../lib/live-list'
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
const terminalLists = new LiveList<Terminal>((t) => t.id)

// keepActive keeps the selection if it still exists, else picks the first.
function keepActive(terminals: Terminal[], activeId: string | null): string | null {
  if (exists(terminals, activeId)) return activeId
  return terminals[0]?.id ?? null
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  ...initial,
  load: async () => {
    try {
      const terminals = await terminalLists.load(listTerminals)
      if (!terminals) return
      const current = get().activeId ?? remembered()
      set({ terminals, activeId: exists(terminals, current) ? current : null, error: null })
    } catch (err) {
      set({ error: message(err) })
    }
  },
  open: async (opts) => {
    try {
      const term = await openTerminal(opts)
      terminalLists.update(term.id, term)
      remember(term.id)
      set((s) => ({
        terminals: s.terminals.some((t) => t.id === term.id)
          ? s.terminals.map((t) => t.id === term.id ? term : t)
          : [...s.terminals, term],
        activeId: term.id, focusId: term.id, error: null,
      }))
    } catch (err) {
      set({ error: message(err) })
    }
  },
  close: async (id) => {
    try {
      await closeTerminal(id)
      terminalLists.update(id, null)
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
      const current = get().terminals.find((t) => t.id === id)
      if (!current) return
      // Rename changes the title; the process may have exited meanwhile.
      const updated = { ...current, title: renamed.title }
      terminalLists.update(id, updated)
      set((s) => ({ terminals: s.terminals.map((t) => (t.id === id ? updated : t)), error: null }))
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
      terminals: s.terminals.map((t) => {
        if (t.id !== id) return t
        const exited: Terminal = { ...t, status: 'exited', exitCode: code }
        terminalLists.update(id, exited)
        return exited
      }),
    })),
}))

export function resetTerminals() {
  terminalLists.reset()
  useTerminalStore.setState(initial)
}
