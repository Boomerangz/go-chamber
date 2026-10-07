import { create } from 'zustand'
import { LiveList } from '../lib/live-list'
import { describeError, fail } from './notices'
import { useSessionStore } from './session'
import { shellsMayHaveGone, shellsWithin } from '../lib/shells'
import {
  closeTerminal,
  renameTerminal,
  listTerminals,
  openTerminal,
  type OpenTerminalOptions,
  type Terminal,
  type TerminalList,
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
  // opening holds the open requests in flight, by openKey: each button
  // is busy for its own request only.
  opening: Record<string, true>
  openError: string | null
  closing: Record<string, true>
  // conn is the connection state of each attached terminal.
  conn: Record<string, ConnState>
  // fontSize is the screen font size of every terminal, in px.
  fontSize: number
  // finding is the terminal whose find bar is open.
  finding: string | null
  // findTick changes each time find is asked for, so the bar takes focus again.
  findTick: number
  // unseen marks terminals scrolled up while new output arrived below.
  unseen: Record<string, true>
  // ended counts the shells this tab knew that a server restart ended,
  // until a shell is opened.
  ended: number
  load: () => Promise<void>
  open: (opts: OpenTerminalOptions) => Promise<boolean>
  dismissOpenError: () => void
  close: (id: string) => Promise<boolean>
  // reopen replaces an exited shell with a new one in the same folder, in
  // the same place and under the same title.
  reopen: (id: string) => Promise<boolean>
  select: (id: string) => void
  rename: (id: string, title: string) => Promise<boolean>
  markExited: (id: string, code: number) => void
  setConnState: (id: string, state: TerminalState, attempt?: number) => void
  setFontSize: (px: number | null) => void
  setFinding: (id: string, on: boolean) => void
  setUnseen: (id: string, on: boolean) => void
}

const initial = {
  terminals: [] as Terminal[],
  loaded: false,
  loadError: null as string | null,
  activeId: null as string | null,
  focusId: null as string | null,
  focusTick: 0,
  missingId: null as string | null,
  opening: {} as Record<string, true>,
  openError: null as string | null,
  closing: {} as Record<string, true>,
  conn: {} as Record<string, ConnState>,
  finding: null as string | null,
  findTick: 0,
  unseen: {} as Record<string, true>,
  ended: 0,
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

// The shells this tab knew, and the server run they belong to, are kept per
// tab: a list from another run that lacks some of them means a restart
// ended them; in the same run they were closed (maybe from elsewhere).
const KNOWN_KEY = 'go-chamber.terminal.known'

interface Known {
  run: string
  ids: string[]
}

function knownShells(): Known | null {
  try {
    const known = JSON.parse(sessionStorage.getItem(KNOWN_KEY) ?? 'null') as Known | null
    return known && typeof known.run === 'string' && Array.isArray(known.ids) ? known : null
  } catch {
    return null
  }
}

function keepKnown(known: Known | null) {
  try {
    if (known) sessionStorage.setItem(KNOWN_KEY, JSON.stringify(known))
  } catch {
    // storage unavailable: a restart's shells just end unremarked
  }
}

// changeKnown adds or drops a shell this tab opened or closed.
function changeKnown(add: string | null, drop: string | null) {
  const known = knownShells()
  if (!known) return
  const ids = known.ids.filter((id) => id !== drop && id !== add)
  keepKnown({ run: known.run, ids: add ? [...ids, add] : ids })
}

const exists = (terminals: Terminal[], id: string | null) => id !== null && terminals.some((t) => t.id === id)
const terminalLists = new LiveList<Terminal>((t) => t.id)

// keepActive keeps the selection if it still exists, else picks the first.
function keepActive(terminals: Terminal[], activeId: string | null): string | null {
  if (exists(terminals, activeId)) return activeId
  return terminals[0]?.id ?? null
}

// openKey names an open request, so the button that asked for it alone
// shows it busy and a second press of it is dropped.
export function openKey(opts: OpenTerminalOptions): string {
  if (opts.sessionId) return `session:${opts.sessionId}`
  if (opts.cwd) return `cwd:${opts.cwd}`
  return 'home'
}

export const FONT_MIN = 9
export const FONT_MAX = 24
export const FONT_DEFAULT = 13
const FONT_KEY = 'gc.terminal.fontSize'
const clampFont = (px: number) => Math.round(Math.min(FONT_MAX, Math.max(FONT_MIN, px)))

function storedFont(): number {
  try {
    const px = Number(localStorage.getItem(FONT_KEY))
    return Number.isFinite(px) && px > 0 ? clampFont(px) : FONT_DEFAULT
  } catch {
    return FONT_DEFAULT
  }
}

export const useTerminalStore = create<TerminalStoreState>((set, get) => {
  const track = (key: string, on: boolean) =>
    set((s) => {
      const opening = { ...s.opening }
      if (on) opening[key] = true
      else delete opening[key]
      return { opening }
    })
  const setTitle = (id: string, title: string): Terminal | null => {
    const current = get().terminals.find((t) => t.id === id)
    if (!current) return null
    const updated = { ...current, title }
    terminalLists.update(id, updated)
    set((s) => ({ terminals: s.terminals.map((t) => (t.id === id ? updated : t)) }))
    return updated
  }
  return {
    ...initial,
    fontSize: storedFont(),
    load: async () => {
      try {
        let run: string | undefined
        const terminals = await terminalLists.load(async () => {
          const list: TerminalList = await listTerminals()
          run = list.run
          return list
        })
        if (!terminals) return
        let ended = get().ended
        if (run) {
          const known = knownShells()
          if (known && known.run !== run) ended = known.ids.filter((id) => !exists(terminals, id)).length
          keepKnown({ run, ids: terminals.map((t) => t.id) })
        }
        const requested = get().activeId
        const current = requested ?? remembered()
        const found = exists(terminals, current)
        set({
          ended,
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
      const key = openKey(opts)
      if (get().opening[key]) return false
      track(key, true)
      try {
        const term = await openTerminal(opts)
        terminalLists.update(term.id, term)
        remember(term.id)
        changeKnown(term.id, null)
        set((s) => ({
          ended: 0,
          terminals: s.terminals.some((t) => t.id === term.id)
            ? s.terminals.map((t) => t.id === term.id ? term : t)
            : [...s.terminals, term],
          activeId: term.id, focusId: term.id, focusTick: s.focusTick + 1,
          missingId: null, openError: null,
        }))
        return true
      } catch (err) {
        set({ openError: describeError(err) })
        return false
      } finally {
        track(key, false)
      }
    },
    reopen: async (id) => {
      const old = get().terminals.find((t) => t.id === id)
      const key = `reopen:${id}`
      if (!old || get().opening[key]) return false
      track(key, true)
      let term: Terminal
      try {
        term = await openTerminal({ cwd: old.cwd })
      } catch (err) {
        track(key, false)
        set({ openError: describeError(err) })
        return false
      }
      if (term.title !== old.title) {
        try {
          term = { ...term, title: (await renameTerminal(term.id, old.title)).title }
        } catch {
          // the new shell keeps its own title
        }
      }
      const fresh = term
      terminalLists.update(fresh.id, fresh)
      terminalLists.update(id, null)
      remember(fresh.id)
      changeKnown(fresh.id, id)
      set((s) => {
        const conn = { ...s.conn }
        delete conn[id]
        return {
          terminals: s.terminals.some((t) => t.id === id) ? s.terminals.map((t) => (t.id === id ? fresh : t)) : [...s.terminals, fresh],
          activeId: fresh.id, focusId: fresh.id, focusTick: s.focusTick + 1, conn, openError: null,
        }
      })
      track(key, false)
      // The exited shell has nothing left to lose; one already gone is fine.
      await closeTerminal(id).catch(() => {})
      return true
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
        changeKnown(null, id)
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
        fail("Couldn't close the terminal", err)
        return false
      }
    },
    rename: async (id, title) => {
      // The new title shows at once; a refusal puts the old one back.
      const before = get().terminals.find((t) => t.id === id)?.title
      const shown = title.trim() ? title : null
      if (shown !== null) setTitle(id, shown)
      try {
        const renamed = await renameTerminal(id, title)
        // Rename changes the title; the process may have exited meanwhile.
        return setTitle(id, renamed.title) !== null
      } catch (err) {
        if (before !== undefined && shown !== null && get().terminals.find((t) => t.id === id)?.title === shown) setTitle(id, before)
        fail("Couldn't rename the terminal", err)
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
    setFontSize: (px) => {
      const fontSize = px === null ? FONT_DEFAULT : clampFont(px)
      set({ fontSize })
      try {
        if (px === null) localStorage.removeItem(FONT_KEY)
        else localStorage.setItem(FONT_KEY, String(fontSize))
      } catch {
        // storage unavailable: the size lasts for this page only
      }
    },
    setFinding: (id, on) => {
      if (on) set((s) => ({ finding: id, findTick: s.findTick + 1 }))
      else if (get().finding === id) set({ finding: null })
    },
    setUnseen: (id, on) => {
      if (Boolean(get().unseen[id]) === on) return
      set((s) => {
        const unseen = { ...s.unseen }
        if (on) unseen[id] = true
        else delete unseen[id]
        return { unseen }
      })
    },
  }
})

export function resetTerminals() {
  terminalLists.reset()
  useTerminalStore.setState({ ...initial, fontSize: storedFont() })
}

// useShellsWithin counts the listed shells working in dir or below it.
export function useShellsWithin(dir: string | undefined): number {
  return useTerminalStore((s) => shellsWithin(s.terminals, dir))
}

// followSessions refreshes the shell list when a session goes or loses its
// worktree folder: the server then let go of its shells, or closed those in
// the folder. It returns the unsubscribe.
export function followSessions(): () => void {
  return useSessionStore.subscribe((s, prev) => {
    if (shellsMayHaveGone(prev.sessions, s.sessions)) void useTerminalStore.getState().load()
  })
}
