import { create } from 'zustand'
import { LiveList } from '../lib/live-list'
import { describeError, fail } from './notices'
import {
  closeTerminal,
  renameTerminal,
  listTerminals,
  openTerminal,
  type OpenTerminalOptions,
  type Terminal,
  type TerminalState,
} from '../lib/terminal'

export interface ConnState {
  state: TerminalState
  attempt?: number
}

interface TerminalStoreState {
  terminals: Terminal[]
  // loaded is set once a list arrived; until then the list is loading, not
  // empty.
  loaded: boolean
  loadError: string | null
  activeId: string | null
  // focusId is the terminal the user just opened or selected; only it takes
  // keyboard focus, so a page load doesn't steal typing from the composer.
  // focusTick changes with every such choice, even of the same terminal.
  focusId: string | null
  focusTick: number
  // missingId is a terminal asked for (a /t/<id> link) that the server no
  // longer has.
  missingId: string | null
  opening: boolean
  openError: string | null
  closing: Record<string, true>
  // conn is the connection state of each attached terminal.
  conn: Record<string, ConnState>
  load: () => Promise<void>
  open: (opts: OpenTerminalOptions) => Promise<boolean>
  dismissOpenError: () => void
  close: (id: string) => Promise<boolean>
  select: (id: string) => void
  rename: (id: string, title: string) => Promise<boolean>
  markExited: (id: string, code: number) => void
  setConnState: (id: string, state: TerminalState, attempt?: number) => void
}

const initial = {
  terminals: [] as Terminal[],
  loaded: false,
  loadError: null as string | null,
  activeId: null as string | null,
  focusId: null as string | null,
  focusTick: 0,
  missingId: null as string | null,
  opening: false,
  openError: null as string | null,
  closing: {} as Record<string, true>,
  conn: {} as Record<string, ConnState>,
}

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

export const useTerminalStore = create<TerminalStoreState>((set, get) => ({
  ...initial,
  load: async () => {
    try {
      const terminals = await terminalLists.load(listTerminals)
      if (!terminals) return
      const requested = get().activeId
      const current = requested ?? remembered()
      const found = exists(terminals, current)
      set({
        terminals,
        activeId: found ? current : null,
        missingId: !found && requested ? requested : get().missingId,
        loaded: true,
        loadError: null,
      })
    } catch (err) {
      set({ loadError: describeError(err) })
    }
  },
  open: async (opts) => {
    if (get().opening) return false
    set({ opening: true })
    try {
      const term = await openTerminal(opts)
      terminalLists.update(term.id, term)
      remember(term.id)
      set((s) => ({
        terminals: s.terminals.some((t) => t.id === term.id)
          ? s.terminals.map((t) => t.id === term.id ? term : t)
          : [...s.terminals, term],
        activeId: term.id, focusId: term.id, focusTick: s.focusTick + 1,
        missingId: null, opening: false, openError: null,
      }))
      return true
    } catch (err) {
      set({ opening: false, openError: describeError(err) })
      return false
    }
  },
  dismissOpenError: () => set({ openError: null }),
  close: async (id) => {
    if (get().closing[id]) return false
    set((s) => ({ closing: { ...s.closing, [id]: true } }))
    const done = (s: TerminalStoreState) => {
      const closing = { ...s.closing }
      delete closing[id]
      return closing
    }
    try {
      await closeTerminal(id)
      terminalLists.update(id, null)
      set((s) => {
        const terminals = s.terminals.filter((t) => t.id !== id)
        const activeId = keepActive(terminals, s.activeId)
        remember(activeId)
        const conn = { ...s.conn }
        delete conn[id]
        const refocus = s.activeId === id
        return {
          terminals, activeId, conn, closing: done(s),
          ...(refocus ? { focusId: activeId, focusTick: s.focusTick + 1 } : {}),
        }
      })
      return true
    } catch (err) {
      set((s) => ({ closing: done(s) }))
      fail('Close terminal failed', err)
      return false
    }
  },
  rename: async (id, title) => {
    try {
      const renamed = await renameTerminal(id, title)
      const current = get().terminals.find((t) => t.id === id)
      if (!current) return false
      // Rename changes the title; the process may have exited meanwhile.
      const updated = { ...current, title: renamed.title }
      terminalLists.update(id, updated)
      set((s) => ({ terminals: s.terminals.map((t) => (t.id === id ? updated : t)) }))
      return true
    } catch (err) {
      fail('Rename failed', err)
      return false
    }
  },
  select: (id) => {
    remember(id)
    set((s) => ({ activeId: id, focusId: id, focusTick: s.focusTick + 1, missingId: null }))
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
  setConnState: (id, state, attempt) => set((s) => ({ conn: { ...s.conn, [id]: { state, attempt } } })),
}))

export function resetTerminals() {
  terminalLists.reset()
  useTerminalStore.setState(initial)
}
