import { create } from 'zustand'
import { recordAgentEvent, recordAgentBatch, markAgentUpdate } from '../lib/diagnostics'
import * as api from '../lib/api'
import { applyEvents, initialChat, type ChatState } from '../lib/events'
import type { GroupMode } from '../lib/sessions'
import { LiveList } from '../lib/live-list'
import { chimeOnEvent } from '../lib/chime'
import { describeError, dropSessionNotices, fail, useNotices } from './notices'
import { parseRoute } from '../lib/route'
import { branchError, folderError } from '../lib/branch'
import { useCLIs } from '../lib/clis'

const START_FAILED = "Couldn't start the session"

export type Connection = 'connecting' | 'online' | 'offline'

export type LoadStatus = 'loading' | 'ready' | 'error'

// HistoryError says why the open chat's transcript didn't load: the
// server doesn't know the session (not_found: retrying won't help), or the
// fetch failed (failed: worth a Retry). reason is the readable cause.
export interface HistoryError {
  kind: 'not_found' | 'failed'
  reason: string
}

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
  // modelsStatus tells a catalog loading or failed from an empty one.
  modelsStatus: Partial<Record<api.AgentKind, LoadStatus>>
  // modelsError says why an agent's catalog failed to load.
  modelsError: Partial<Record<api.AgentKind, string>>
  // sessionsStatus tells a list still loading (or failed) from an empty one.
  sessionsStatus: LoadStatus
  // sessionsError, requestsError and quotasError say why a first load
  // failed, while its status is 'error'.
  sessionsError: string | null
  requestsError: string | null
  quotasError: string | null
  // history is the state of the open chat's transcript fetch.
  history: LoadStatus
  // historyError is set while history is 'error'.
  historyError: HistoryError | null
  // requestsStatus tells a request inbox still loading (or failed) from an
  // empty one.
  requestsStatus: LoadStatus
  // searching is true while the server searches messages for the query.
  searching: boolean
  // searchError is why the last message search failed; null when it didn't.
  searchError: string | null
  // quotasStatus tells quotas still loading (or failed) from none reported.
  quotasStatus: LoadStatus
  // nextRetryAt is when the live socket tries again after a drop (ms epoch).
  nextRetryAt: number | null

  setPane: (pane: Pane) => void
  setGroupMode: (cwd: string, mode: GroupMode) => void
  setQuery: (query: string) => void
  searchMessages: (query: string) => Promise<void>
  loadModels: (agent: api.AgentKind) => Promise<void>
  setModel: (sessionId: string, choice: api.ModelChoice) => Promise<boolean>
  loadSessions: () => Promise<void>
  loadRequests: () => Promise<void>
  loadQuotas: () => Promise<void>
  // createSession starts a session in cwd, or in a new worktree on branch chamber/<branch>.
  // With inForm, a folder that isn't there is left to the form to say.
  createSession: (agent: api.AgentKind, cwd: string, branch?: string, inForm?: boolean) => Promise<boolean>
  selectSession: (id: string) => Promise<void>
  // closeSession leaves the open session for the empty workspace.
  closeSession: () => void
  send: (text: string, images?: string[]) => Promise<boolean>
  steer: (text: string) => Promise<boolean>
  interrupt: () => Promise<boolean>
  continueSession: () => Promise<boolean>
  setAutoContinue: (sessionId: string, on: boolean) => Promise<boolean>
  forkSession: (sessionId: string) => Promise<boolean>
  importHistory: (agent: api.AgentKind, nativeId: string) => Promise<boolean>
  stopTask: (sessionId: string, taskId: string) => Promise<boolean>
  setApprovalReviewer: (sessionId: string, reviewer: api.ApprovalReviewer) => Promise<boolean>
  renameSession: (sessionId: string, title: string) => Promise<boolean>
  // archiveSession puts a session away from the list; unarchiveSession
  // brings it back.
  archiveSession: (sessionId: string) => Promise<boolean>
  unarchiveSession: (sessionId: string) => Promise<boolean>
  // deleteSession removes go-chamber's record of a session and its
  // subagents; removeWorktree takes its worktree folder too (branch kept).
  deleteSession: (sessionId: string, opts?: api.DeleteOptions) => Promise<boolean>
  setPermissionMode: (sessionId: string, mode: string) => Promise<boolean>
  removeWorktree: (sessionId: string, force: boolean) => Promise<void>
  respond: (sessionId: string, requestId: string, answer: api.RequestAnswerInput) => Promise<boolean>
  applyIncoming: (ev: api.SessionEvent) => void
  setConnection: (c: Connection) => void
  // connect keeps the live event socket open, reconnecting when it drops.
  connect: () => void
  // retryNow reconnects at once instead of waiting out the backoff.
  retryNow: () => void
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
let healthTimer: ReturnType<typeof setTimeout> | null = null
// HEALTH_PROBE_MS is how often a dropped socket asks /api/health whether the
// server is back: a cheap request, so a restart is noticed within a second or
// two instead of after a backoff that may have grown to half a minute.
const HEALTH_PROBE_MS = 1500
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
const modelsFailed = new Set<api.AgentKind>()
let wakeListening = false

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
  const before = sessions.find((s) => s.id === updated.id)
  // A gone folder is seen by a listing or a refused send; a state update
  // doesn't look, so it keeps the mark until a turn proves the folder back.
  if (before?.folderGone && !('folderGone' in updated) && before.cwd === updated.cwd && updated.status !== 'running' && updated.status !== 'idle') {
    updated = { ...updated, folderGone: true }
  }
  recordSessionChanges(before, updated)
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
  modelsStatus: {},
  modelsError: {},
  sessionsStatus: 'loading',
  sessionsError: null,
  requestsError: null,
  quotasError: null,
  history: 'ready',
  historyError: null,
  requestsStatus: 'loading',
  searching: false,
  searchError: null,
  quotasStatus: 'loading',
  nextRetryAt: null,

  setConnection: (connection) => set({ connection }),
  connect: () => connect(get, set),
  retryNow: () => retryNow(get, set),
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
    if (get().models[agent] && !modelsFailed.has(agent)) return
    if (get().modelsStatus[agent] === 'loading') return
    set({ modelsStatus: { ...get().modelsStatus, [agent]: 'loading' } })
    try {
      const list = await api.listModels(agent)
      modelsFailed.delete(agent)
      const { [agent]: _, ...modelsError } = get().modelsError
      set({ models: { ...get().models, [agent]: list }, modelsStatus: { ...get().modelsStatus, [agent]: 'ready' }, modelsError })
    } catch (err) {
      // An agent without a catalog says so: that is an answer. Anything else
      // failed: the picker offers only the default and a retry, and asks
      // again next time it opens.
      const why = describeError(err)
      const unsupported = /not supported/i.test(why)
      if (!unsupported) modelsFailed.add(agent)
      set({
        models: { ...get().models, [agent]: [] },
        modelsStatus: { ...get().modelsStatus, [agent]: unsupported ? 'ready' : 'error' },
        ...(unsupported ? {} : { modelsError: { ...get().modelsError, [agent]: why } }),
      })
    }
  },

  async setModel(sessionId, choice) {
    const before = sessionRevision
    const preference = ++preferenceRequest
    try {
      const updated = await api.setModel(sessionId, choice)
      set({ sessions: applySessionMutation(get().sessions, before, updated) })
      if (preference > (modelPreferenceRequests.get(updated.agent) ?? 0)) {
        modelPreferenceRequests.set(updated.agent, preference)
        rememberModel(updated.agent, choice)
      }
      return true
    } catch (err) {
      fail("Couldn't change the model", err)
      return false
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
      set({ searchHits: [], searching: false, searchError: null })
      return
    }
    set({ searching: true, searchError: null })
    try {
      const hits = await api.searchMessages(query.trim())
      if (mine === searchGeneration) set({ searchHits: hits, searching: false })
    } catch (err) {
      if (mine === searchGeneration) set({ searchHits: [], searching: false, searchError: describeError(err) })
    }
  },

  async loadSessions() {
    try {
      const sessions = await sessionLists.load(api.listSessions)
      if (sessions) {
        const current = new Map(get().sessions.map((session) => [session.id, session]))
        for (const session of sessions) recordSessionChanges(current.get(session.id), session)
        set({ sessions, sessionsStatus: 'ready', sessionsError: null })
        useNotices.getState().dismissKey('load-sessions')
      }
    } catch (err) {
      // Before the list ever loaded, the sidebar says so with a Retry; a
      // failed refresh of a shown list can only be told as a notice.
      const shown = get().sessionsStatus === 'ready'
      if (!shown) set({ sessionsStatus: 'error', sessionsError: describeError(err) })
      const open = get().activeId
      if (!shown && open) void fetchOpenSession(get, set, open)
      fail("Couldn't load sessions", err, 'load-sessions', { quiet: !shown })
    }
  },

  async loadRequests() {
    try {
      const pendingRequests = await requestLists.load(api.listRequests)
      if (pendingRequests) {
        set({ pendingRequests, requestsStatus: 'ready', requestsError: null })
        useNotices.getState().dismissKey('load-requests')
      }
    } catch (err) {
      // As with sessions: the tray shows a first failure in place.
      const shown = get().requestsStatus === 'ready'
      if (!shown) set({ requestsStatus: 'error', requestsError: describeError(err) })
      fail("Couldn't load requests", err, 'load-requests', { quiet: !shown })
    }
  },

  async loadQuotas() {
    try {
      const quotas = await quotaLists.load(api.getQuotas)
      if (quotas) set({ quotas, quotasStatus: 'ready', quotasError: null })
    } catch (err) {
      // A first failure is said in place by the sidebar footer.
      const shown = get().quotasStatus === 'ready'
      if (!shown) set({ quotasStatus: 'error', quotasError: describeError(err) })
      fail("Couldn't load quotas", err, 'load-quotas', { quiet: !shown })
    }
  },

  async createSession(agent, cwd, branch, inForm) {
    try {
      const created = branch
        ? await api.createWorktreeSession(agent, cwd, branch, startChoice(agent))
        : await api.createSession(agent, cwd, startChoice(agent))
      set({ sessions: replaceSession(get().sessions, created) })
      // An earlier failed start is over now.
      useNotices.getState().dismissKey(START_FAILED)
      await get().selectSession(created.id)
      return true
    } catch (err) {
      // The form explains a refused folder under its field, and a refused
      // branch under the branch; anything else is a notice.
      const why = describeError(err)
      const inPlace = Boolean(inForm && (folderError(why) || (branch && branchError(why))))
      fail(START_FAILED, err, undefined, { quiet: inPlace })
      return false
    }
  },

  async selectSession(id) {
    // The open session is already live: just bring it forward.
    if (id === get().activeId && get().history !== 'error') {
      set({ pane: 'chat' })
      return
    }
    buffered = null
    dropQueued()
    set({ activeId: id, chat: initialChat(), pane: 'chat', history: 'loading', historyError: null })
    connect(get, set)
    if (get().sessionsStatus === 'error') void fetchOpenSession(get, set, id)
    await resync(get, set, id)
  },

  closeSession: () => closeChat(set),

  async send(text, images) {
    const id = get().activeId
    if (!id || (!text.trim() && !images?.length)) return false
    try {
      await (images?.length ? api.sendMessage(id, text, images) : api.sendMessage(id, text))
      useNotices.getState().dismissKey('send')
      return true
    } catch (err) {
      // The folder is gone: the chat says so in the composer's place.
      const session = get().sessions.find((s) => s.id === id)
      if ((err as { code?: unknown } | null)?.code === 'folder_gone' && session) {
        set({ sessions: replaceSession(get().sessions, { ...session, folderGone: true }) })
        return false
      }
      // The CLI is missing: once the CLI list knows it, the chat says so in
      // the composer's place.
      if ((err as { code?: unknown } | null)?.code === 'cli_missing' && session) {
        await useCLIs.getState().load()
        if (useCLIs.getState().clis.some((c) => c.agent === session.agent && !c.found)) return false
      }
      fail("Couldn't send the message", err, 'send')
      return false
    }
  },

  async steer(text) {
    const id = get().activeId
    if (!id || !text.trim()) return false
    try {
      await api.steer(id, text)
      useNotices.getState().dismissKey('send')
      return true
    } catch (err) {
      fail("Couldn't steer the turn", err, 'send')
      return false
    }
  },

  async setPermissionMode(sessionId, mode) {
    const before = sessionRevision
    const preference = ++preferenceRequest
    try {
      const updated = await api.setPermissionMode(sessionId, mode)
      set({ sessions: applySessionMutation(get().sessions, before, updated) })
      if (preference > (modePreferenceRequests.get(updated.agent) ?? 0)) {
        modePreferenceRequests.set(updated.agent, preference)
        rememberMode(updated.agent, mode)
      }
      return true
    } catch (err) {
      fail("Couldn't change the permission mode", err)
      return false
    }
  },

  async renameSession(sessionId, title) {
    const before = sessionRevision
    try {
      const updated = await api.renameSession(sessionId, title)
      set({ sessions: applySessionMutation(get().sessions, before, updated) })
      return true
    } catch (err) {
      fail("Couldn't rename the session", err)
      return false
    }
  },

  async archiveSession(sessionId) {
    const before = sessionRevision
    try {
      const updated = await api.archiveSession(sessionId)
      set({ sessions: applySessionMutation(get().sessions, before, updated) })
      return true
    } catch (err) {
      fail("Couldn't archive the session", err)
      return false
    }
  },

  async unarchiveSession(sessionId) {
    const before = sessionRevision
    try {
      const updated = await api.unarchiveSession(sessionId)
      set({ sessions: applySessionMutation(get().sessions, before, updated) })
      return true
    } catch (err) {
      fail("Couldn't unarchive the session", err)
      return false
    }
  },

  async deleteSession(sessionId, opts) {
    try {
      await (opts ? api.deleteSession(sessionId, opts) : api.deleteSession(sessionId))
    } catch (err) {
      fail("Couldn't delete the session", err)
      return false
    }
    removeSession(get, set, sessionId)
    return true
  },

  async setApprovalReviewer(sessionId, reviewer) {
    const before = sessionRevision
    try {
      const updated = await api.setApprovalReviewer(sessionId, reviewer)
      set({ sessions: applySessionMutation(get().sessions, before, updated) })
      return true
    } catch (err) {
      fail("Couldn't change the approval reviewer", err)
      return false
    }
  },

  async stopTask(sessionId, taskId) {
    try {
      await api.stopTask(sessionId, taskId)
      return true
    } catch (err) {
      fail("Couldn't stop the subagent", err)
      return false
    }
  },

  async interrupt() {
    const id = get().activeId
    if (!id) return false
    try {
      await api.interrupt(id)
      return true
    } catch (err) {
      fail("Couldn't stop the turn", err)
      return false
    }
  },

  async continueSession() {
    const id = get().activeId
    if (!id) return false
    try {
      await api.continueSession(id)
      return true
    } catch (err) {
      fail("Couldn't continue the session", err)
      return false
    }
  },

  async setAutoContinue(sessionId, on) {
    const before = sessionRevision
    try {
      const updated = await api.setAutoContinue(sessionId, on)
      set({ sessions: applySessionMutation(get().sessions, before, updated) })
      return true
    } catch (err) {
      fail("Couldn't change auto-continue", err)
      return false
    }
  },

  async forkSession(sessionId) {
    try {
      const fork = await api.forkSession(sessionId)
      set({ sessions: replaceSession(get().sessions, fork) })
      await get().selectSession(fork.id)
      return true
    } catch (err) {
      fail("Couldn't fork the session", err)
      return false
    }
  },

  async importHistory(agent, nativeId) {
    try {
      const imported = await api.importHistory(agent, nativeId)
      set({ sessions: replaceSession(get().sessions, imported) })
      await get().selectSession(imported.id)
      return true
    } catch (err) {
      // The history panel says so under the conversation (reason: lastError).
      fail("Couldn't open the CLI session", err, undefined, { quiet: true })
      return false
    }
  },

  async respond(sessionId, requestId, answer) {
    try {
      await api.respondRequest(sessionId, requestId, answer)
      return true
    } catch (err) {
      // The request's card or tray line says so in place (reason: lastError).
      fail("Couldn't send the answer", err, undefined, { quiet: true })
      return false
    }
  },

  applyIncoming(ev) {
    recordAgentEvent()
    chimeOnEvent(ev)
    const prev = lastSeqs[ev.sessionId]
    lastSeqs[ev.sessionId] = Math.max(prev ?? 0, ev.seq)
    if (prev !== undefined && ev.seq > prev + 1) {
      // The hub dropped events for this slow consumer; the tray and quotas
      // may have missed some, so reload them.
      void get().loadRequests()
      void get().loadQuotas()
    }
    if (ev.type === 'session.removed') {
      removeSession(get, set, ev.sessionId)
      return
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

// closeChat empties the workspace, superseding the open chat's history
// fetch and live queue.
function closeChat(set: (partial: Partial<SessionStore>) => void): void {
  generation++
  buffered = null
  dropQueued()
  set({ activeId: null, chat: initialChat(), history: 'ready', historyError: null })
}

// removeSession forgets a deleted session and the subagents below it, with
// their requests. If it was open, the workspace returns to the empty state.
function removeSession(get: () => SessionStore, set: (partial: Partial<SessionStore>) => void, id: string): void {
  const { sessions, pendingRequests, activeId } = get()
  const gone = new Set([id])
  // Parents come before children only by chance; repeat until settled.
  for (let grew = true; grew; ) {
    grew = false
    for (const s of sessions) {
      if (s.parentId && gone.has(s.parentId) && !gone.has(s.id)) {
        gone.add(s.id)
        grew = true
      }
    }
  }
  for (const sid of gone) {
    sessionLists.update(sid, null)
    sessionRevisions.delete(sid)
    delete lastSeqs[sid]
  }
  dropSessionNotices(gone)
  const dropped = pendingRequests.filter((r) => gone.has(r.sessionId))
  for (const r of dropped) requestLists.update(requestKey(r), null)
  set({
    sessions: sessions.filter((s) => !gone.has(s.id)),
    pendingRequests: dropped.length ? pendingRequests.filter((r) => !gone.has(r.sessionId)) : pendingRequests,
  })
  if (!activeId || !gone.has(activeId)) return
  closeChat(set)
  set({ pane: 'sessions' })
  if (typeof location === 'undefined') return
  const route = parseRoute(location.pathname)
  if (route.kind === 'session' && gone.has(route.id)) window.history.replaceState(null, '', '/' + location.search)
}

function connect(
  get: () => SessionStore,
  set: (partial: Partial<SessionStore>) => void,
): void {
  if (socket || typeof WebSocket === 'undefined') return
  listenForWake(get, set)
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  stopHealthProbe()
  const scheme = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss' : 'ws'
  const host = typeof location !== 'undefined' ? location.host : 'localhost'
  const ws = new WebSocket(`${scheme}://${host}/api/ws`)
  socket = ws
  set({ connection: 'connecting' })
  ws.onopen = () => {
    reconnectDelay = 1000
    set({ connection: 'online', nextRetryAt: null })
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
    set({ connection: 'offline', nextRetryAt: Date.now() + reconnectDelay })
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect(get, set)
    }, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
    probeHealth(get, set)
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

// fetchOpenSession asks for the open session alone when the session list
// failed to load: the chat header needs its folder, model and mode either
// way. A list that arrives first wins.
async function fetchOpenSession(
  get: () => SessionStore,
  set: (partial: Partial<SessionStore>) => void,
  id: string,
): Promise<void> {
  try {
    const session = await api.getSession(id)
    if (get().activeId !== id || get().sessions.some((s) => s.id === id)) return
    set({ sessions: [...get().sessions, session] })
  } catch {
    // The transcript fetch says what is wrong with this session.
  }
}

// probeHealth asks the server, every HEALTH_PROBE_MS while the socket is
// down, whether it is back, and reconnects the moment it says so.
function probeHealth(get: () => SessionStore, set: (partial: Partial<SessionStore>) => void): void {
  stopHealthProbe()
  healthTimer = setTimeout(() => {
    healthTimer = null
    void Promise.resolve()
      .then(() => api.fetchHealth())
      .catch(() => 'offline' as const)
      .then((health) => {
        if (socket) return
        if (health === 'online') retryNow(get, set)
        else if (!healthTimer) probeHealth(get, set)
      })
  }, HEALTH_PROBE_MS)
}

function stopHealthProbe(): void {
  if (healthTimer) clearTimeout(healthTimer)
  healthTimer = null
}

// retryNow skips the rest of the backoff: the owner asked, or the page
// just came back (wake from sleep, network back, tab shown).
function retryNow(get: () => SessionStore, set: (partial: Partial<SessionStore>) => void): void {
  if (socket) return
  reconnectDelay = 1000
  connect(get, set)
}

// listenForWake reconnects as soon as the device can talk again, instead of
// waiting out a backoff that grew while the laptop slept.
function listenForWake(get: () => SessionStore, set: (partial: Partial<SessionStore>) => void): void {
  if (wakeListening || typeof window === 'undefined') return
  wakeListening = true
  const wake = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    retryNow(get, set)
  }
  window.addEventListener('online', wake)
  document.addEventListener('visibilitychange', wake)
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
    set({ chat, history: 'ready', historyError: null })
    useNotices.getState().dismissKey('history')
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
      // A session the server doesn't know won't turn up by asking again.
      const notFound = (err as { status?: unknown } | null)?.status === 404
      retry = !notFound && live.some((ev) => ev.seq > chat.lastSeq)
      const historyError: HistoryError = { kind: notFound ? 'not_found' : 'failed', reason: describeError(err) }
      set({ chat, history: 'error', historyError })
      // The chat shows the failure in place (historyError), with a Retry.
      fail("Couldn't load the transcript", err, 'history', { quiet: true })
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

// resetStore restores the initial state; used by tests.
export function resetStore(): void {
  preferenceRequest++
  modelPreferenceRequests.clear()
  modePreferenceRequests.clear()
  sessionRevision++
  sessionRevisions.clear()
  modelsFailed.clear()
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
  stopHealthProbe()
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
    modelsStatus: {},
    modelsError: {},
    sessionsStatus: 'loading',
    sessionsError: null,
    requestsError: null,
    quotasError: null,
    history: 'ready',
    historyError: null,
    requestsStatus: 'loading',
    searching: false,
    searchError: null,
    quotasStatus: 'loading',
    nextRetryAt: null,
  })
}
