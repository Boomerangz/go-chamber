import { create } from 'zustand'
import { fetchEvents, type Item, type Session, type SessionEvent } from '../lib/api'
import { basename } from '../lib/format'

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
  dismissed: boolean
  historyError?: boolean
}
const empty = (): AttentionEntry => ({ seq: 0, summary: '', activity: 'Working', actions: {}, waiting: {}, result: '', dismissed: false })

export function brief(text: string, words = 14): string {
  const clean = text.replace(/[`*#]/g, '').trim().replace(/\s+/g, ' ')
  const parts = clean.split(' ')
  const short = parts.slice(0, words).join(' ')
  return short.slice(0, 140) + (parts.length > words || short.length > 140 ? '…' : '')
}

export function elapsed(start: number | undefined, now: number): string {
  if (start === undefined) return '—'
  const seconds = Math.max(0, Math.floor((now - start) / 1000))
  const part = (n: number) => String(n).padStart(2, '0')
  const minutes = Math.floor(seconds / 60)
  return `${minutes >= 60 ? `${Math.floor(minutes / 60)}:` : ''}${part(minutes % 60)}:${part(seconds % 60)}`
}

export function actionLabel(item: Item): string {
  const input = (item.input && typeof item.input === 'object' ? item.input : {}) as Record<string, unknown>
  const file = basename(String(item.path || input.file_path || input.path || 'file'))
  const name = item.name || 'tool'
  if (item.kind === 'command' || name === 'Bash' || name === 'exec_command') return `Running ${brief(String(input.command || input.cmd || item.text || name), 8)}`
  if (item.kind === 'file_change' || /^(Edit|Write|apply_patch)$/.test(name)) return `Editing ${file}`
  if (name === 'Read' || name === 'read_file') return `Reading ${file}`
  if (/^(Grep|Glob|search)$/.test(name)) return `Searching ${brief(String(input.pattern || input.query || 'project'), 6)}`
  if (item.kind === 'subagent') return `Agent: ${brief(item.name || item.text || 'working', 6)}`
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
    e.waiting = { ...e.waiting, [ev.request.id]: at }
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
    if (item.kind === 'user_message') e.summary = brief(item.text || '', 8)
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

interface AttentionStore {
  entries: Record<string, AttentionEntry>
  ingest: (event: SessionEvent, at?: number) => void
  refresh: (sessions: Session[]) => Promise<void>
  dismiss: (id: string) => void
  reset: () => void
}
type Observed = { event: SessionEvent; at?: number }
const loading = new Map<string, Observed[]>()
let generation = 0

// A small projection of every session, independent of the selected transcript.
// Live times are observation times. History has no event timestamps: leave
// action/wait/end times unknown rather than restarting their clocks on replay.
export const useAttention = create<AttentionStore>((set, get) => ({
  entries: {},
  ingest(event, at) {
    loading.get(event.sessionId)?.push({ event, at })
    const before = get().entries[event.sessionId]
    const next = fold(before, event, at)
    if (next === before) return
    const entries = { ...get().entries }
    if (next) entries[event.sessionId] = next
    else delete entries[event.sessionId]
    set({ entries })
  },
  async refresh(sessions) {
    const mine = generation
    // Sequential reads avoid loading many full transcripts simultaneously.
    for (const session of sessions) {
      if (mine !== generation) return
      if (session.parentId || loading.has(session.id)) continue
      const known = get().entries[session.id]
      if (session.status !== 'running' && !known) continue
      const base = known || { ...empty(), startedAt: timestamp(session.activeAt) }
      const live: Observed[] = []
      loading.set(session.id, live)
      try {
        // Rebuild from history: a newer state event can arrive after a gap,
        // so the greatest observed sequence is not a contiguous checkpoint.
        const history = await fetchEvents(session.id, 0)
        if (mine !== generation) return
        const combined = new Map(history.map((event) => {
          const at = event.type === 'turn.started' && event.seq === base.turnSeq ? base.startedAt
            : event.type === 'turn.ended' && event.seq === base.endedSeq ? base.endedAt
            : event.type === 'item.updated' && event.item ? base.actions[event.item.id]?.since
            : event.type === 'request.opened' && event.request ? base.waiting[event.request.id] : undefined
          return [event.seq, { event, at } as Observed]
        }))
        for (const observed of live) combined.set(observed.event.seq, observed)
        let entry: AttentionEntry | undefined = history.length ? { ...empty(), startedAt: timestamp(session.activeAt) } : { ...base, historyError: false }
        for (const { event, at } of [...combined.values()].sort((a, b) => a.event.seq - b.event.seq)) entry = fold(entry, event, at)
        const entries = { ...get().entries }
        if (entry?.outcome && entries[session.id]?.endedSeq === entry.endedSeq) entry.dismissed = entries[session.id]!.dismissed
        if (entry) entries[session.id] = entry
        else delete entries[session.id]
        set({ entries })
      } catch {
        if (mine === generation && !live.some(({ event }) => event.type === 'session.removed')) set({ entries: { ...get().entries, [session.id]: { ...(get().entries[session.id] || base), historyError: true } } })
      } finally {
        if (loading.get(session.id) === live) loading.delete(session.id)
      }
    }
  },
  dismiss(id) {
    const entry = get().entries[id]
    if (entry) set({ entries: { ...get().entries, [id]: { ...entry, dismissed: true } } })
  },
  reset() { generation++; loading.clear(); set({ entries: {} }) },
}))
