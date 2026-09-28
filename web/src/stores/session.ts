import { create } from 'zustand'
import * as api from '../lib/api'
import { applyEvent, initialChat, type ChatState } from '../lib/events'
import type { GroupMode } from '../lib/sessions'

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
  send: (text: string, images?: string[]) => Promise<void>
  steer: (text: string) => Promise<void>
  interrupt: () => Promise<void>
  continueSession: () => Promise<void>
  setAutoContinue: (sessionId: string, on: boolean) => Promise<void>
  forkSession: (sessionId: string) => Promise<void>
  stopTask: (sessionId: string, taskId: string) => Promise<void>
  setApprovalReviewer: (sessionId: string, reviewer: api.ApprovalReviewer) => Promise<void>
  setPermissionMode: (sessionId: string, mode: string) => Promise<void>
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
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1000
// queued holds live events for the active chat not yet folded in: text
// deltas are applied at most every DELTA_FLUSH_MS so fast streams don't
// re-render the whole chat per token.
let queued: api.SessionEvent[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
const DELTA_FLUSH_MS = 100
// lastSeqs is the last live seq seen per session, to spot events the hub
// dropped for sessions other than the open one.
let lastSeqs: Record<string, number> = {}

// replaceSession swaps in the server's copy: Go omits empty fields, so
// merging would keep values the server has cleared.
function replaceSession(sessions: api.Session[], updated: api.Session): api.Session[] {
  return sessions.some((s) => s.id === updated.id)
    ? sessions.map((s) => (s.id === updated.id ? updated : s))
    : [...sessions, updated]
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
    try {
      const updated = await api.setModel(sessionId, choice)
      set({ sessions: replaceSession(get().sessions, updated), error: null })
      rememberModel(updated.agent, choice)
    } catch (err) {
      set({ error: errorMessage(err) })
    }
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
      set({ sessions: await api.listSessions(), error: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async loadRequests() {
    try {
      set({ pendingRequests: await api.listRequests(), error: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async loadQuotas() {
    try {
      set({ quotas: await api.getQuotas(), error: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async createSession(agent, cwd, branch) {
    try {
      const created = branch
        ? await api.createWorktreeSession(agent, cwd, branch, startChoice(agent))
        : await api.createSession(agent, cwd, startChoice(agent))
      set({ sessions: [...get().sessions, created], error: null })
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
    if (!id || (!text.trim() && !images?.length)) return
    try {
      await (images?.length ? api.sendMessage(id, text, images) : api.sendMessage(id, text))
      set({ error: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async steer(text) {
    const id = get().activeId
    if (!id || !text.trim()) return
    try {
      await api.steer(id, text)
      set({ error: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async setPermissionMode(sessionId, mode) {
    try {
      const updated = await api.setPermissionMode(sessionId, mode)
      set({ sessions: replaceSession(get().sessions, updated), error: null })
      rememberMode(updated.agent, mode)
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async setApprovalReviewer(sessionId, reviewer) {
    try {
      const updated = await api.setApprovalReviewer(sessionId, reviewer)
      set({ sessions: replaceSession(get().sessions, updated), error: null })
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
    try {
      const updated = await api.setAutoContinue(sessionId, on)
      set({ sessions: replaceSession(get().sessions, updated), error: null })
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

  async respond(sessionId, requestId, answer) {
    try {
      await api.respondRequest(sessionId, requestId, answer)
      set({ error: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  applyIncoming(ev) {
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
      const quotas = get().quotas
      const known = quotas.some((q) => q.agent === ev.quota!.agent)
      set({
        quotas: known
          ? quotas.map((q) => (q.agent === ev.quota!.agent ? { ...q, ...ev.quota! } : q))
          : [...quotas, ev.quota],
      })
    }
    if (ev.type === 'request.opened' && ev.request) {
      const rest = get().pendingRequests.filter((r) => r.id !== ev.request!.id)
      set({ pendingRequests: [...rest, ev.request] })
    }
    if (ev.type === 'request.resolved' && ev.request) {
      set({ pendingRequests: get().pendingRequests.filter((r) => r.id !== ev.request!.id) })
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
      void resync(get, set, id)
      return
    }
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
): Promise<void> {
  const mine = ++generation
  flush(get, set)
  const live: api.SessionEvent[] = []
  buffered = live
  try {
    const history = await api.fetchEvents(id, get().chat.lastSeq)
    if (mine !== generation) return
    let chat = get().chat
    for (const ev of [...history, ...live]) chat = applyEvent(chat, ev)
    set({ chat, error: null })
  } catch (err) {
    if (mine === generation) set({ error: errorMessage(err) })
  } finally {
    // A newer resync owns the buffer now; leave it alone.
    if (mine === generation) buffered = null
  }
}

// flush folds queued live events into the active chat.
function flush(get: () => SessionStore, set: (partial: Partial<SessionStore>) => void): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (queued.length === 0) return
  let chat = get().chat
  for (const ev of queued) chat = applyEvent(chat, ev)
  queued = []
  set({ chat })
}

function dropQueued(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  queued = []
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// resetStore restores the initial state; used by tests.
export function resetStore(): void {
  if (socket) {
    socket.onclose = null
    socket.close()
    socket = null
  }
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  reconnectDelay = 1000
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
