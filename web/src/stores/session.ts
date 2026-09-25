import { create } from 'zustand'
import * as api from '../lib/api'
import { applyEvent, initialChat, type ChatState } from '../lib/events'

export type Connection = 'connecting' | 'online' | 'offline'

export interface SessionStore {
  sessions: api.Session[]
  activeId: string | null
  chat: ChatState
  pendingRequests: api.SessionRequest[]
  quotas: api.QuotaSnapshot[]
  connection: Connection
  error: string | null

  loadSessions: () => Promise<void>
  loadRequests: () => Promise<void>
  loadQuotas: () => Promise<void>
  createSession: (agent: api.AgentKind, cwd: string) => Promise<void>
  selectSession: (id: string) => Promise<void>
  send: (text: string) => Promise<void>
  steer: (text: string) => Promise<void>
  interrupt: () => Promise<void>
  stopTask: (sessionId: string, taskId: string) => Promise<void>
  setApprovalReviewer: (sessionId: string, reviewer: api.ApprovalReviewer) => Promise<void>
  respond: (sessionId: string, requestId: string, answer: api.RequestAnswerInput) => Promise<void>
  applyIncoming: (ev: api.SessionEvent) => void
  setConnection: (c: Connection) => void
}

let socket: WebSocket | null = null
let buffered: api.SessionEvent[] | null = null
let generation = 0

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  activeId: null,
  chat: initialChat(),
  pendingRequests: [],
  quotas: [],
  connection: 'connecting',
  error: null,

  setConnection: (connection) => set({ connection }),

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

  async createSession(agent, cwd) {
    try {
      const created = await api.createSession(agent, cwd)
      set({ sessions: [...get().sessions, created], error: null })
      await get().selectSession(created.id)
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async selectSession(id) {
    buffered = null
    set({ activeId: id, chat: initialChat(), error: null })
    connect(get, set)
    await resync(get, set, id)
  },

  async send(text) {
    const id = get().activeId
    if (!id || !text.trim()) return
    try {
      await api.sendMessage(id, text)
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

  async setApprovalReviewer(sessionId, reviewer) {
    try {
      const updated = await api.setApprovalReviewer(sessionId, reviewer)
      set({
        sessions: get().sessions.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)),
        error: null,
      })
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

  async respond(sessionId, requestId, answer) {
    try {
      await api.respondRequest(sessionId, requestId, answer)
      set({ error: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  applyIncoming(ev) {
    if (ev.session) {
      const sessions = get().sessions
      const known = sessions.some((s) => s.id === ev.session!.id)
      set({
        sessions: known
          ? sessions.map((s) => (s.id === ev.session!.id ? { ...s, ...ev.session! } : s))
          : [...sessions, ev.session],
      })
    }
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
    if (ev.seq > get().chat.lastSeq + 1) {
      // The hub drops events for slow consumers; refetch the gap from history.
      void resync(get, set, id)
      return
    }
    set({ chat: applyEvent(get().chat, ev) })
  },
}))

function connect(
  get: () => SessionStore,
  set: (partial: Partial<SessionStore>) => void,
): void {
  if (socket || typeof WebSocket === 'undefined') return
  const scheme = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss' : 'ws'
  const host = typeof location !== 'undefined' ? location.host : 'localhost'
  const ws = new WebSocket(`${scheme}://${host}/api/ws`)
  socket = ws
  ws.onopen = () => {
    set({ connection: 'online' })
    // The server subscribes us only now: anything published between the
    // history snapshot and this point never reaches the socket.
    const id = get().activeId
    if (id) void resync(get, set, id)
  }
  ws.onclose = () => {
    socket = null
    set({ connection: 'offline' })
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
    buffered = null
  }
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
  buffered = null
  generation++
  useSessionStore.setState({
    sessions: [],
    activeId: null,
    chat: initialChat(),
    pendingRequests: [],
    quotas: [],
    connection: 'connecting',
    error: null,
  })
}
