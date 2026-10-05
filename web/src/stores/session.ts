import { create } from 'zustand'
import { recordAgentEvent, recordAgentBatch, markAgentUpdate } from '../lib/diagnostics'
import * as api from '../lib/api'
import { applyEvents, initialChat, type ChatState } from '../lib/events'
import type { GroupMode } from '../lib/sessions'
import { LiveList } from '../lib/live-list'

export type Connection = 'connecting' | 'online' | 'offline'

// Pane is the view shown on narrow screens, where only one fits at a time.
export type Pane = 'sessions' | 'chat' | 'requests' | 'changes'

export interface SessionStore {
  sessions: api.Session[]
  activeId: string | null
  chat: ChatState
  pendingRequests: api.SessionRequest[]
  quotas: api.QuotaSnapshot[]
  connection: Connection
  pane: Pane
  // groupModes is how each project folder is expanded in the sidebar.
  groupModes: Record<string, GroupMode>
  query: string
  // searchHits are sessions whose messages match the query.
  searchHits: api.SearchHit[]
  // models caches each agent's model catalog; empty when unsupported.
  models: Partial<Record<api.AgentKind, api.ModelInfo[]>>
  error: string | null

  setPane: (pane: Pane) => void
  setGroupMode: (cwd: string, mode: GroupMode) => void
  setQuery: (query: string) => void
  searchMessages: (query: string) => Promise<void>
  loadModels: (agent: api.AgentKind) => Promise<void>
  setModel: (sessionId: string, choice: api.ModelChoice) => Promise<void>
  loadSessions: () => Promise<void>
  loadRequests: () => Promise<void>
  loadQuotas: () => Promise<void>
  // createSession starts a session in cwd, or in a new worktree on branch chamber/<branch>.
  createSession: (agent: api.AgentKind, cwd: string, branch?: string) => Promise<void>
  selectSession: (id: string) => Promise<void>
  send: (text: string, images?: string[]) => Promise<boolean>
  steer: (text: string) => Promise<boolean>
  interrupt: () => Promise<void>
  continueSession: () => Promise<void>
  setAutoContinue: (sessionId: string, on: boolean) => Promise<void>
  forkSession: (sessionId: string) => Promise<void>
  importHistory: (agent: api.AgentKind, nativeId: string) => Promise<void>
  stopTask: (sessionId: string, taskId: string) => Promise<void>
  setApprovalReviewer: (sessionId: string, reviewer: api.ApprovalReviewer) => Promise<void>
  renameSession: (sessionId: string, title: string) => Promise<void>
  setPermissionMode: (sessionId: string, mode: string) => Promise<void>
  removeWorktree: (sessionId: string, force: boolean) => Promise<void>
  respond: (sessionId: string, requestId: string, answer: api.RequestAnswerInput) => Promise<void>
  applyIncoming: (ev: api.SessionEvent) => void
  setConnection: (c: Connection) => void
  // connect keeps the live event socket open, reconnecting when it drops.
  connect: () => void
}

const GROUP_MODES_KEY = 'gc.groupModes'

function loadGroupModes(): Record<string, GroupMode> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(GROUP_MODES_KEY) ?? '{}')
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, GroupMode>) : {}
  } catch {
    return {}
  }
}

const LAST_MODEL_KEY = 'gc.lastModel'

// lastModel is the model choice last made for an agent; new sessions start
// with it.
function lastModel(agent: api.AgentKind): api.ModelChoice | undefined {
  try {
    const all = JSON.parse(localStorage.getItem(LAST_MODEL_KEY) ?? '{}') as Record<string, api.ModelChoice>
    return all[agent]
  } catch {
    return undefined
  }
}

function rememberModel(agent: api.AgentKind, choice: api.ModelChoice): void {
  try {
    const all = JSON.parse(localStorage.getItem(LAST_MODEL_KEY) ?? '{}') as Record<string, api.ModelChoice>
    localStorage.setItem(LAST_MODEL_KEY, JSON.stringify({ ...all, [agent]: choice }))
  } catch {
    // storage unavailable: new sessions use the agent's default
  }
}

const LAST_MODE_KEY = 'gc.lastPermissionMode'

// startChoice is what a new session of the agent starts with: the model
// and permission mode last chosen for it.
function startChoice(agent: api.AgentKind): (api.ModelChoice & { permissionMode?: string }) | undefined {
  let mode: string | undefined
  try {
    mode = (JSON.parse(localStorage.getItem(LAST_MODE_KEY) ?? '{}') as Record<string, string>)[agent]
  } catch {
    // storage unavailable: the agent's configuration decides
  }
  const model = lastModel(agent)
  if (!mode) return model
  return { model: '', effort: '', ...model, permissionMode: mode }
}

function rememberMode(agent: api.AgentKind, mode: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(LAST_MODE_KEY) ?? '{}') as Record<string, string>
    localStorage.setItem(LAST_MODE_KEY, JSON.stringify({ ...all, [agent]: mode }))
  } catch {
    // storage unavailable: new sessions use the agent's configuration
  }
}

let socket: WebSocket | null = null
let searchGeneration = 0
let buffered: api.SessionEvent[] | null = null
let generation = 0
let resyncTimer: ReturnType<typeof setTimeout> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1000
// queued holds live events for the active chat not yet folded in: text
// deltas are applied at most every DELTA_FLUSH_MS so fast streams don't
// re-render the whole chat per token.
let queued: api.SessionEvent[] = []
let queuedAt: number | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
const DELTA_FLUSH_MS = 100
// lastSeqs is the last live seq seen per session, to spot events the hub
// dropped for sessions other than the open one.
let lastSeqs: Record<string, number> = {}
const sessionLists = new LiveList<api.Session>((s) => s.id)
// A request id is unique only within its session.
const requestKey = (r: api.SessionRequest) => `${r.sessionId}/${r.id}`
const requestLists = new LiveList<api.SessionRequest>(requestKey)
const quotaLists = new LiveList<api.QuotaSnapshot>((q) => q.agent)
let sessionRevision = 0
const sessionRevisions = new Map<string, Partial<Record<keyof api.Session, number>>>()
let preferenceRequest = 0
const modelPreferenceRequests = new Map<api.AgentKind, number>()
const modePreferenceRequests = new Map<api.AgentKind, number>()

function recordSessionChanges(before: api.Session | undefined, updated: api.Session): void {
  const revisions = sessionRevisions.get(updated.id) ?? {}
  const keys = Object.keys({ ...before, ...updated }) as (keyof api.Session)[]
  for (const key of keys) {
    if (before?.[key] !== updated[key]) revisions[key] = ++sessionRevision
  }
  sessionRevisions.set(updated.id, revisions)
}

// replaceSession swaps in the server's copy: Go omits empty fields, so
// merging would keep values the server has cleared.
function replaceSession(sessions: api.Session[], updated: api.Session): api.Session[] {
  recordSessionChanges(sessions.find((s) => s.id === updated.id), updated)
  sessionLists.update(updated.id, updated)
  return sessions.some((s) => s.id === updated.id)
    ? sessions.map((s) => (s.id === updated.id ? updated : s))
    : [...sessions, updated]
}

// A mutation response changes its requested fields, but must retain fields
// updated live since that request began (including fields cleared by Go).
function applySessionMutation(sessions: api.Session[], before: number, updated: api.Session): api.Session[] {
  const current = sessions.find((s) => s.id === updated.id)
  const revisions = sessionRevisions.get(updated.id)
  if (current && revisions) {
    updated = { ...updated }
    const keys = Object.keys(revisions) as (keyof api.Session)[]
    for (const key of keys) {
      if ((revisions[key] ?? 0) <= before) continue
      if (key in current) Object.assign(updated, { [key]: current[key] })
      else Reflect.deleteProperty(updated, key)
    }
  }
  return replaceSession(sessions, updated)
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  activeId: null,
  chat: initialChat(),
  pendingRequests: [],
  quotas: [],
  connection: 'connecting',
  pane: 'sessions',
  groupModes: loadGroupModes(),
  query: '',
  searchHits: [],
  models: {},
  error: null,

  setConnection: (connection) => set({ connection }),
  connect: () => connect(get, set),
  setPane: (pane) => set({ pane }),
  setGroupMode: (cwd, mode) => {
    const groupModes = { ...get().groupModes, [cwd]: mode }
    set({ groupModes })
    try {
      localStorage.setItem(GROUP_MODES_KEY, JSON.stringify(groupModes))
    } catch {
      // storage unavailable: keep the mode for this page only
    }
  },
  setQuery: (query) => set({ query }),

  async loadModels(agent) {
    if (get().models[agent]) return
    let list: api.ModelInfo[] = []
    try {
      list = await api.listModels(agent)
    } catch {
      // the agent can't list models: the picker offers only its default
    }
    set({ models: { ...get().models, [agent]: list } })
  },

  async setModel(sessionId, choice) {
    const before = sessionRevision
    const preference = ++preferenceRequest
    try {
      const updated = await api.setModel(sessionId, choice)
      set({ sessions: applySessionMutation(get().sessions, before, updated), error: null })
      if (preference > (modelPreferenceRequests.get(updated.agent) ?? 0)) {
        modelPreferenceRequests.set(updated.agent, preference)
        rememberModel(updated.agent, choice)
      }
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async removeWorktree(sessionId, force) {
    const before = sessionRevision
    const updated = await api.removeWorktree(sessionId, force)
    set({ sessions: applySessionMutation(get().sessions, before, updated) })
  },

  async searchMessages(query) {
    const mine = ++searchGeneration
    if (query.trim().length < 2) {
      set({ searchHits: [] })
      return
    }
    try {
      const hits = await api.searchMessages(query.trim())
      if (mine === searchGeneration) set({ searchHits: hits })
    } catch {
      if (mine === searchGeneration) set({ searchHits: [] })
    }
  },

  async loadSessions() {
    try {
      const sessions = await sessionLists.load(api.listSessions)
      if (sessions) {
        const current = new Map(get().sessions.map((session) => [session.id, session]))
        for (const session of sessions) recordSessionChanges(current.get(session.id), session)
        set({ sessions, error: null })
      }
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async loadRequests() {
    try {
      const pendingRequests = await requestLists.load(api.listRequests)
      if (pendingRequests) set({ pendingRequests, error: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async loadQuotas() {
    try {
      const quotas = await quotaLists.load(api.getQuotas)
      if (quotas) set({ quotas, error: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async createSession(agent, cwd, branch) {
    try {
      const created = branch
        ? await api.createWorktreeSession(agent, cwd, branch, startChoice(agent))
        : await api.createSession(agent, cwd, startChoice(agent))
      set({ sessions: replaceSession(get().sessions, created), error: null })
      await get().selectSession(created.id)
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async selectSession(id) {
    buffered = null
    dropQueued()
    set({ activeId: id, chat: initialChat(), pane: 'chat', error: null })
    connect(get, set)
    await resync(get, set, id)
  },

  async send(text, images) {
    const id = get().activeId
    if (!id || (!text.trim() && !images?.length)) return false
    try {
      await (images?.length ? api.sendMessage(id, text, images) : api.sendMessage(id, text))
      set({ error: null })
      return true
    } catch (err) {
      set({ error: errorMessage(err) })
      return false
    }
  },

  async steer(text) {
    const id = get().activeId
    if (!id || !text.trim()) return false
    try {
      await api.steer(id, text)
      set({ error: null })
      return true
    } catch (err) {
      set({ error: errorMessage(err) })
      return false
    }
  },

  async setPermissionMode(sessionId, mode) {
    const before = sessionRevision
    const preference = ++preferenceRequest
    try {
      const updated = await api.setPermissionMode(sessionId, mode)
      set({ sessions: applySessionMutation(get().sessions, before, updated), error: null })
      if (preference > (modePreferenceRequests.get(updated.agent) ?? 0)) {
        modePreferenceRequests.set(updated.agent, preference)
        rememberMode(updated.agent, mode)
      }
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async renameSession(sessionId, title) {
    const before = sessionRevision
    try {
      const updated = await api.renameSession(sessionId, title)
      set({ sessions: applySessionMutation(get().sessions, before, updated), error: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async setApprovalReviewer(sessionId, reviewer) {
    const before = sessionRevision
    try {
      const updated = await api.setApprovalReviewer(sessionId, reviewer)
      set({ sessions: applySessionMutation(get().sessions, before, updated), error: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async stopTask(sessionId, taskId) {
    try {
      await api.stopTask(sessionId, taskId)
      set({ error: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async interrupt() {
    const id = get().activeId
    if (!id) return
    try {
      await api.interrupt(id)
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async continueSession() {
    const id = get().activeId
    if (!id) return
    try {
      await api.continueSession(id)
      set({ error: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async setAutoContinue(sessionId, on) {
    const before = sessionRevision
    try {
      const updated = await api.setAutoContinue(sessionId, on)
      set({ sessions: applySessionMutation(get().sessions, before, updated), error: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async forkSession(sessionId) {
    try {
      const fork = await api.forkSession(sessionId)
      set({ sessions: replaceSession(get().sessions, fork), error: null })
      await get().selectSession(fork.id)
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async importHistory(agent, nativeId) {
    try {
      const imported = await api.importHistory(agent, nativeId)
      set({ sessions: replaceSession(get().sessions, imported), error: null })
      await get().selectSession(imported.id)
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async respond(sessionId, requestId, answer) {
    try {
      await api.respondRequest(sessionId, requestId, answer)
      set({ error: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  applyIncoming(ev) {
    recordAgentEvent()
    const prev = lastSeqs[ev.sessionId]
    lastSeqs[ev.sessionId] = Math.max(prev ?? 0, ev.seq)
    if (prev !== undefined && ev.seq > prev + 1) {
      // The hub dropped events for this slow consumer; the tray and quotas
      // may have missed some, so reload them.
      void get().loadRequests()
      void get().loadQuotas()
    }
    if (ev.session) set({ sessions: replaceSession(get().sessions, ev.session) })
    if (ev.type === 'quota' && ev.quota) {
      quotaLists.update(ev.quota.agent, ev.quota)
      const quotas = get().quotas
      const known = quotas.some((q) => q.agent === ev.quota!.agent)
      set({
        quotas: known
          ? quotas.map((q) => (q.agent === ev.quota!.agent ? { ...q, ...ev.quota! } : q))
          : [...quotas, ev.quota],
      })
    }
    if (ev.type === 'request.opened' && ev.request) {
      const key = requestKey(ev.request)
      requestLists.update(key, ev.request)
      const rest = get().pendingRequests.filter((r) => requestKey(r) !== key)
      set({ pendingRequests: [...rest, ev.request] })
    }
    if (ev.type === 'request.resolved' && ev.request) {
      const key = requestKey(ev.request)
      requestLists.update(key, null)
      set({ pendingRequests: get().pendingRequests.filter((r) => requestKey(r) !== key) })
    }
    const id = get().activeId
    if (!id || ev.sessionId !== id) return
    if (buffered) {
      buffered.push(ev)
      return
    }
    const last = queued.length > 0 ? queued[queued.length - 1]!.seq : get().chat.lastSeq
    if (ev.seq > last + 1) {
      // The hub drops events for slow consumers; refetch the gap from history.
      flush(get, set)
      void resync(get, set, id, ev)
      return
    }
    if (queued.length === 0) queuedAt = performance.now()
    queued.push(ev)
    if (ev.type !== 'text.delta') flush(get, set)
    else flushTimer ??= setTimeout(() => flush(get, set), DELTA_FLUSH_MS)
  },
}))

function connect(
  get: () => SessionStore,
  set: (partial: Partial<SessionStore>) => void,
): void {
  if (socket || typeof WebSocket === 'undefined') return
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  const scheme = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss' : 'ws'
  const host = typeof location !== 'undefined' ? location.host : 'localhost'
  const ws = new WebSocket(`${scheme}://${host}/api/ws`)
  socket = ws
  ws.onopen = () => {
    reconnectDelay = 1000
    set({ connection: 'online' })
    // Anything missed while offline: reload the lists the socket feeds.
    lastSeqs = {}
    void get().loadSessions()
    void get().loadRequests()
    void get().loadQuotas()
    // The server subscribes us only now: anything published between the
    // history snapshot and this point never reaches the socket.
    const id = get().activeId
    if (id) void resync(get, set, id)
  }
  ws.onclose = () => {
    if (socket !== ws) return
    socket = null
    set({ connection: 'offline' })
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect(get, set)
    }, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
  }
  ws.onerror = () => set({ connection: 'offline' })
  ws.onmessage = (msg) => {
    try {
      get().applyIncoming(JSON.parse(msg.data as string) as api.SessionEvent)
    } catch {
      // ignore malformed frames
    }
  }
}

// resync fetches the active session's events after chat.lastSeq and folds
// them in, followed by live events that arrived meanwhile (anything buffered
// before the fetch started is in its response). A newer resync (another
// selection, the socket opening, a later gap) supersedes an older one.
async function resync(
  get: () => SessionStore,
  set: (partial: Partial<SessionStore>) => void,
  id: string,
  trigger?: api.SessionEvent,
): Promise<void> {
  if (resyncTimer) clearTimeout(resyncTimer)
  resyncTimer = null
  const mine = ++generation
  flush(get, set)
  const live: api.SessionEvent[] = buffered ?? []
  if (trigger) live.push(trigger)
  buffered = live
  let retry = false
  try {
    const history = await api.fetchEvents(id, get().chat.lastSeq)
    if (mine !== generation) return
    const chat = applyEvents(get().chat, [...history, ...live])
    set({ chat, error: null })
  } catch (err) {
    if (mine === generation) {
      const initial = get().chat
      let lastSeq = initial.lastSeq
      const contiguous: api.SessionEvent[] = []
      for (const ev of live) {
        if (ev.seq > lastSeq + 1) break
        lastSeq = Math.max(lastSeq, ev.seq)
        contiguous.push(ev)
      }
      const chat = applyEvents(initial, contiguous)
      // Keep events beyond a missing prefix for the next history fetch;
      // advancing lastSeq over that gap would make replay discard it.
      retry = live.some((ev) => ev.seq > chat.lastSeq)
      set({ chat, error: errorMessage(err) })
      if (retry) resyncTimer = setTimeout(() => void resync(get, set, id), 1000)
    }
  } finally {
    // A newer resync owns the buffer now; leave it alone.
    if (mine === generation && !retry) buffered = null
  }
}

// flush folds queued live events into the active chat.
function flush(get: () => SessionStore, set: (partial: Partial<SessionStore>) => void): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (queued.length === 0) return
  recordAgentBatch(performance.now() - (queuedAt ?? performance.now()), queued.length)
  const chat = applyEvents(get().chat, queued)
  queued = []
  queuedAt = null
  if (get().activeId) markAgentUpdate(get().activeId!)
  set({ chat })
}

function dropQueued(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  queued = []
  queuedAt = null
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// resetStore restores the initial state; used by tests.
export function resetStore(): void {
  preferenceRequest++
  modelPreferenceRequests.clear()
  modePreferenceRequests.clear()
  sessionRevision++
  sessionRevisions.clear()
  sessionLists.reset()
  requestLists.reset()
  quotaLists.reset()
  if (socket) {
    socket.onclose = null
    socket.close()
    socket = null
  }
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  reconnectDelay = 1000
  if (resyncTimer) clearTimeout(resyncTimer)
  resyncTimer = null
  lastSeqs = {}
  dropQueued()
  buffered = null
  generation++
  useSessionStore.setState({
    sessions: [],
    activeId: null,
    chat: initialChat(),
    pendingRequests: [],
    quotas: [],
    connection: 'connecting',
    pane: 'sessions',
    groupModes: loadGroupModes(),
    query: '',
    searchHits: [],
    models: {},
    error: null,
  })
}
