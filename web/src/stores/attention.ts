import { create } from 'zustand'
import { fetchEvents, type Item, type Session, type SessionEvent } from '../lib/api'
import { basename } from '../lib/format'
import { describeError } from './notices'
import { isUnseen } from '../lib/visits'

export interface AttentionEntry {
  seq: number
  turnSeq?: number
  endedSeq?: number
  startedAt?: number
  endedAt?: number
  summary: string
  activity: string
  actions: Record<string, { label: string; since?: number }>
  waiting: Record<string, number | undefined>
  result: string
  outcome?: string
  // dismissed hides a result at once, until the server's seen mark (which
  // decides whether it is news) catches up.
  dismissed: boolean
  // historyError is why the session's activity couldn't load.
  historyError?: string
}
const empty = (): AttentionEntry => ({ seq: 0, summary: '', activity: 'Working', actions: {}, waiting: {}, result: '', dismissed: false })

export function brief(text: string, words = 14): string {
  const clean = text.replace(/[`*#]/g, '').trim().replace(/\s+/g, ' ')
  const parts = clean.split(' ')
  const short = parts.slice(0, words).join(' ')
  return short.slice(0, 140) + (parts.length > words || short.length > 140 ? '…' : '')
}

// elapsed reads the time from start to now as the chat's working line does:
// m:ss, or h:mm:ss past an hour.
export function elapsed(start: number | undefined, now: number): string {
  if (start === undefined) return '—'
  const seconds = Math.max(0, Math.floor((now - start) / 1000))
  const part = (n: number) => String(n).padStart(2, '0')
  const minutes = Math.floor(seconds / 60)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${part(minutes % 60)}:${part(seconds % 60)}` : `${minutes}:${part(seconds % 60)}`
}

export function actionLabel(item: Item): string {
  const input = (item.input && typeof item.input === 'object' ? item.input : {}) as Record<string, unknown>
  const file = basename(String(item.path || input.file_path || input.path || 'file'))
  const name = item.name || 'tool'
  if (item.kind === 'subagent') return `Subagent: ${brief(String(input.description || item.text || item.agentId || input.subagent_type || 'working'), 6)}`
  if (item.kind === 'command' || name === 'Bash' || name === 'exec_command') return `Running ${brief(String(input.command || input.cmd || item.text || name), 8)}`
  if (item.kind === 'file_change' || /^(Edit|Write|apply_patch)$/.test(name)) return `Editing ${file}`
  if (name === 'Read' || name === 'read_file') return `Reading ${file}`
  if (/^(Grep|Glob|search)$/.test(name)) return `Searching ${brief(String(input.pattern || input.query || 'project'), 6)}`
  return `Using ${name}`
}

function timestamp(value?: string): number | undefined {
  const n = Date.parse(value || '')
  return Number.isFinite(n) ? n : undefined
}

function fold(before: AttentionEntry | undefined, ev: SessionEvent, at?: number): AttentionEntry | undefined {
  if (ev.type === 'text.delta') return before
  if (ev.seq <= (before?.seq ?? 0)) return before
  if (ev.type === 'session.removed') return undefined
  let e = { ...(before || empty()), seq: ev.seq }
  if (ev.type === 'turn.started') {
    e = { ...empty(), seq: ev.seq, turnSeq: ev.seq, startedAt: timestamp(ev.session?.activeAt) ?? at ?? before?.startedAt }
  } else if (ev.type === 'request.opened' && ev.request) {
    e.waiting = { ...e.waiting, [ev.request.id]: timestamp(ev.request.openedAt) ?? at }
  } else if (ev.type === 'request.resolved' && ev.request) {
    e.waiting = { ...e.waiting }
    delete e.waiting[ev.request.id]
  } else if (ev.type === 'turn.ended') {
    e.endedAt = at
    e.endedSeq = ev.seq
    e.actions = {}
    e.waiting = {}
    const r = ev.result
    e.outcome = r?.stopped ? 'Stopped' : r?.interruptionReason ? 'Interrupted' : r?.isError ? 'Failed' : 'Done'
    e.result = brief(r?.error || r?.text || '')
    e.dismissed = false
  } else if (ev.type === 'item.updated' && ev.item) {
    const item = ev.item
    // The whole first line: the card cuts it to its width.
    if (item.kind === 'user_message' && !item.parentItemId) e.summary = brief(item.text || '', 60)
    if (item.kind === 'assistant_message' && !e.outcome && Object.keys(e.actions).length === 0) e.activity = 'Writing a reply'
    if (['command', 'tool_call', 'file_change', 'subagent'].includes(item.kind)) {
      e.actions = { ...e.actions }
      const label = actionLabel(item)
      if (item.status === 'pending' || item.status === 'streaming') {
        e.actions[item.id] = { label, since: e.actions[item.id] ? e.actions[item.id].since : at }
      } else {
        delete e.actions[item.id]
        e.activity = item.status === 'failed' ? `Failed: ${label}` : 'Working'
      }
    }
  }
  return e
}

export interface RefreshOptions {
  // catchUp asks every followed session for what it missed: the live socket
  // was down, so events may have been lost without a gap to show it.
  catchUp?: boolean
}

interface AttentionStore {
  entries: Record<string, AttentionEntry>
  ingest: (event: SessionEvent, at?: number) => void
  refresh: (sessions: Session[], options?: RefreshOptions) => Promise<void>
  dismiss: (id: string) => void
  undismiss: (id: string) => void
  reset: () => void
}
type Observed = { event: SessionEvent; at?: number }
const loading = new Map<string, Observed[]>()
// synced is, per session, the seq up to which the entry has every event:
// live events extend it one by one, so a followed session needs no fetch.
const synced = new Map<string, number>()
// stale sessions skipped a seq on the live socket: rebuild them.
const stale = new Set<string>()
let generation = 0

// followed tells the sessions the panel shows: the running ones and those
// whose last turn the owner hasn't seen.
function followed(session: Session): boolean {
  return !session.parentId && (session.status === 'running' || isUnseen(session))
}

// A small projection of every session, independent of the selected transcript.
// Live times are observation times. History has no event timestamps: leave
// action/wait/end times unknown rather than restarting their clocks on replay.
export const useAttention = create<AttentionStore>((set, get) => ({
  entries: {},
  ingest(event, at) {
    const id = event.sessionId
    const buffer = loading.get(id)
    if (buffer) buffer.push({ event, at })
    else {
      const upTo = synced.get(id)
      if (upTo === undefined) {
        // A session born while this page listens: nothing came before.
        if (event.seq === 1) synced.set(id, 1)
      } else if (event.seq === upTo + 1) synced.set(id, event.seq)
      else if (event.seq > upTo + 1) stale.add(id)
    }
    if (event.type === 'session.removed') {
      synced.delete(id)
      stale.delete(id)
    }
    const before = get().entries[id]
    const next = fold(before, event, at)
    if (next === before) return
    const entries = { ...get().entries }
    if (next) entries[id] = next
    else delete entries[id]
    set({ entries })
  },
  async refresh(sessions, { catchUp = false } = {}) {
    const mine = generation
    // Sequential reads avoid loading many transcripts simultaneously.
    for (const session of sessions) {
      if (mine !== generation) return
      if (!followed(session) || loading.has(session.id)) continue
      const upTo = stale.has(session.id) ? undefined : synced.get(session.id)
      if (upTo !== undefined && !catchUp) continue
      // Rebuild from the start unless the entry holds every event so far:
      // a newer event can arrive after a gap, so the greatest folded seq is
      // not a checkpoint.
      const since = upTo ?? 0
      const known = get().entries[session.id]
      const base = known || { ...empty(), startedAt: timestamp(session.activeAt) }
      const live: Observed[] = []
      loading.set(session.id, live)
      try {
        const history = await fetchEvents(session.id, since)
        if (mine !== generation) return
        const combined = new Map(history.map((event) => {
          const at = since > 0 ? undefined
            : event.type === 'turn.started' && event.seq === base.turnSeq ? base.startedAt
            : event.type === 'turn.ended' && event.seq === base.endedSeq ? base.endedAt
            : event.type === 'item.updated' && event.item ? base.actions[event.item.id]?.since
            : event.type === 'request.opened' && event.request ? base.waiting[event.request.id] : undefined
          return [event.seq, { event, at } as Observed]
        }))
        for (const observed of live) combined.set(observed.event.seq, observed)
        const ordered = [...combined.values()].sort((a, b) => a.event.seq - b.event.seq)
        let entry: AttentionEntry | undefined
        if (since > 0) entry = { ...base, historyError: undefined }
        else entry = history.length ? { ...empty(), startedAt: timestamp(session.activeAt) } : { ...base, historyError: undefined }
        for (const { event, at } of ordered) entry = fold(entry, event, at)
        const entries = { ...get().entries }
        if (entry?.outcome && entries[session.id]?.endedSeq === entry.endedSeq) entry.dismissed = entries[session.id]!.dismissed
        if (entry) entries[session.id] = entry
        else delete entries[session.id]
        set({ entries })
        if (entry) {
          synced.set(session.id, Math.max(since, base.seq, ...ordered.map(({ event }) => event.seq)))
          stale.delete(session.id)
        }
      } catch (err) {
        if (mine === generation && !live.some(({ event }) => event.type === 'session.removed')) {
          set({ entries: { ...get().entries, [session.id]: { ...(get().entries[session.id] || base), historyError: describeError(err) } } })
        }
      } finally {
        if (loading.get(session.id) === live) loading.delete(session.id)
      }
    }
  },
  dismiss(id) {
    const entry = get().entries[id]
    if (entry) set({ entries: { ...get().entries, [id]: { ...entry, dismissed: true } } })
  },
  undismiss(id) {
    const entry = get().entries[id]
    if (entry?.dismissed) set({ entries: { ...get().entries, [id]: { ...entry, dismissed: false } } })
  },
  reset() { generation++; loading.clear(); synced.clear(); stale.clear(); set({ entries: {} }) },
}))
