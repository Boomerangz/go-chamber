import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Item, SessionEvent, Session, SessionRequest, QuotaSnapshot, SearchHit } from '../lib/api'

vi.mock('../lib/api', () => ({
  listSessions: vi.fn(),
  listRequests: vi.fn(),
  getQuotas: vi.fn(),
  refreshQuota: vi.fn(),
  createSession: vi.fn(),
  fetchEvents: vi.fn(),
  sendMessage: vi.fn(),
  steer: vi.fn(),
  stopTask: vi.fn(),
  setApprovalReviewer: vi.fn(),
  renameSession: vi.fn(),
  interrupt: vi.fn(),
  respondRequest: vi.fn(),
  searchMessages: vi.fn(),
  listModels: vi.fn(),
  setModel: vi.fn(),
  setPermissionMode: vi.fn(),
  setAutoContinue: vi.fn(),
  importHistory: vi.fn(),
}))

vi.mock('../lib/chime', () => ({ chimeOnEvent: vi.fn() }))

import * as api from '../lib/api'
import { chimeOnEvent } from '../lib/chime'
import { resetStore, useSessionStore } from './session'
import { diagnostics, resetDiagnostics, beginAgentView, endAgentView, recordAgentCommit } from '../lib/diagnostics'
import { lastError, resetNotices, useNotices } from './notices'

const store = () => useSessionStore.getState()

const item = (over: Partial<Item> = {}): Item => ({
  id: 'i1', sessionId: 'a', kind: 'assistant_message', status: 'completed', ...over,
})

const event = (over: Partial<SessionEvent>): SessionEvent => ({
  seq: 1, sessionId: 'a', type: 'item.updated', item: item(), ...over,
})

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.stubGlobal('WebSocket', undefined)
  resetStore()
  resetNotices()
  ;(api.fetchEvents as Mock).mockResolvedValue([])
})

describe('session store', () => {
  it('matches a reloaded session list to existing sessions in linear work', async () => {
    let idReads = 0
    const sessions: Session[] = Array.from({ length: 1000 }, (_, i) => ({
      get id() { idReads++; return `s${i}` },
      agent: 'claude', cwd: '/p', status: 'idle', title: 'Old title',
    }))
    const refreshed = sessions.map((session) => ({ ...session, title: 'Fresh title' }))
    useSessionStore.setState({ sessions })
    ;(api.listSessions as Mock).mockResolvedValue(refreshed)
    idReads = 0
    await store().loadSessions()
    expect(idReads).toBeLessThanOrEqual(sessions.length * 10)
    expect(store().sessions).toHaveLength(1000)
    expect(store().sessions[999].title).toBe('Fresh title')
  })

  it('remembers the latest successful model choice when responses finish out of order', async () => {
    const initial: Session = { id: 'a', agent: 'codex', cwd: '/p', status: 'idle' }
    useSessionStore.setState({ sessions: [initial] })
    let first: (v: Session) => void = () => {}
    let latest: (v: Session) => void = () => {}
    ;(api.setModel as Mock)
      .mockReturnValueOnce(new Promise((r) => (first = r)))
      .mockReturnValueOnce(new Promise((r) => (latest = r)))
    const earlier = store().setModel('a', { model: 'first', effort: '' })
    const newer = store().setModel('a', { model: 'latest', effort: 'high' })
    latest({ ...initial, model: 'latest', effort: 'high' })
    await newer
    first({ ...initial, model: 'first' })
    await earlier
    ;(api.createSession as Mock).mockResolvedValueOnce({ ...initial, id: 'n' })
    await store().createSession('codex', '/p')
    expect(api.createSession).toHaveBeenLastCalledWith('codex', '/p', { model: 'latest', effort: 'high' })
  })

  it('remembers the latest successful permission choice when responses finish out of order', async () => {
    const initial: Session = { id: 'a', agent: 'codex', cwd: '/p', status: 'idle' }
    useSessionStore.setState({ sessions: [initial] })
    let first: (v: Session) => void = () => {}
    let latest: (v: Session) => void = () => {}
    ;(api.setPermissionMode as Mock)
      .mockReturnValueOnce(new Promise((r) => (first = r)))
      .mockReturnValueOnce(new Promise((r) => (latest = r)))
    const earlier = store().setPermissionMode('a', 'full-access')
    const newer = store().setPermissionMode('a', 'auto')
    latest({ ...initial, permissionMode: 'auto' })
    await newer
    first({ ...initial, permissionMode: 'full-access' })
    await earlier
    ;(api.createSession as Mock).mockResolvedValueOnce({ ...initial, id: 'n' })
    await store().createSession('codex', '/p')
    expect(api.createSession).toHaveBeenLastCalledWith('codex', '/p', { model: '', effort: '', permissionMode: 'auto' })
  })

  it('orders model preferences across different sessions of the same agent', async () => {
    const initial: Session = { id: 'a', agent: 'codex', cwd: '/p', status: 'idle' }
    useSessionStore.setState({ sessions: [initial, { ...initial, id: 'b' }] })
    let release: (v: Session) => void = () => {}
    ;(api.setModel as Mock)
      .mockReturnValueOnce(new Promise((r) => (release = r)))
      .mockResolvedValueOnce({ ...initial, id: 'b', model: 'latest' })
    const pending = store().setModel('a', { model: 'first', effort: '' })
    await store().setModel('b', { model: 'latest', effort: '' })
    release({ ...initial, model: 'first' })
    await pending
    expect(JSON.parse(localStorage.getItem('gc.lastModel')!)).toEqual({ codex: { model: 'latest', effort: '' } })
  })

  it('remembers an earlier successful choice if the newer request failed', async () => {
    const initial: Session = { id: 'a', agent: 'codex', cwd: '/p', status: 'idle' }
    useSessionStore.setState({ sessions: [initial] })
    let release: (v: Session) => void = () => {}
    ;(api.setModel as Mock)
      .mockReturnValueOnce(new Promise((r) => (release = r)))
      .mockRejectedValueOnce(new Error('unsupported model'))
    const pending = store().setModel('a', { model: 'first', effort: '' })
    await store().setModel('a', { model: 'bad', effort: '' })
    release({ ...initial, model: 'first' })
    await pending
    expect(JSON.parse(localStorage.getItem('gc.lastModel')!)).toEqual({ codex: { model: 'first', effort: '' } })
  })

  it.each([
    { name: 'rename', response: api.renameSession, run: () => store().renameSession('a', 'logs'), change: { title: 'logs' } },
    { name: 'model', response: api.setModel, run: () => store().setModel('a', { model: 'new', effort: '' }), change: { model: 'new' } },
    { name: 'permission mode', response: api.setPermissionMode, run: () => store().setPermissionMode('a', 'plan'), change: { permissionMode: 'plan' } },
    { name: 'reviewer', response: api.setApprovalReviewer, run: () => store().setApprovalReviewer('a', 'auto_review'), change: { approvalReviewer: 'auto_review' } },
    { name: 'auto continue', response: api.setAutoContinue, run: () => store().setAutoContinue('a', true), change: { autoContinue: true } },
  ])('keeps live status updates before a delayed $name response', async ({ response, run, change }) => {
    const initial: Session = { id: 'a', agent: 'codex', cwd: '/p', status: 'running' }
    useSessionStore.setState({ sessions: [initial] })
    let release: (v: Session) => void = () => {}
    ;(response as Mock).mockReturnValueOnce(new Promise((r) => (release = r)))
    const pending = run()
    store().applyIncoming(event({ type: 'session.state', session: { ...initial, status: 'idle' } }))
    release({ ...initial, ...change } as Session)
    await pending
    expect(store().sessions[0]).toMatchObject({ status: 'idle', ...change })
  })

  it('does not restore a model cleared by a live event before a rename response', async () => {
    const initial: Session = { id: 'a', agent: 'codex', cwd: '/p', status: 'running', model: 'old' }
    useSessionStore.setState({ sessions: [initial] })
    let release: (v: Session) => void = () => {}
    ;(api.renameSession as Mock).mockReturnValueOnce(new Promise((r) => (release = r)))
    const pending = store().renameSession('a', 'logs')
    store().applyIncoming(event({ type: 'session.state', session: { id: 'a', agent: 'codex', cwd: '/p', status: 'idle' } }))
    release({ ...initial, title: 'logs' })
    await pending
    expect(store().sessions[0]).toMatchObject({ status: 'idle', title: 'logs' })
    expect(store().sessions[0]).not.toHaveProperty('model')
  })

  it('keeps a newer model change back to the original value before an older response', async () => {
    const initial: Session = { id: 'a', agent: 'codex', cwd: '/p', status: 'idle', model: 'original' }
    useSessionStore.setState({ sessions: [initial] })
    let release: (v: Session) => void = () => {}
    ;(api.setModel as Mock).mockReturnValueOnce(new Promise((r) => (release = r)))
    const pending = store().setModel('a', { model: 'first', effort: '' })
    store().applyIncoming(event({ type: 'session.state', session: { ...initial, model: 'first' } }))
    store().applyIncoming(event({ seq: 2, type: 'session.state', session: initial }))
    release({ ...initial, model: 'first' })
    await pending
    expect(store().sessions[0]!.model).toBe('original')
  })

  it('does not duplicate a created session already received in the session list', async () => {
    let release: (v: Session) => void = () => {}
    const created: Session = { id: 'n', agent: 'codex', cwd: '/p', status: 'detached' }
    ;(api.createSession as Mock).mockReturnValueOnce(new Promise((r) => (release = r)))
    ;(api.listSessions as Mock).mockResolvedValueOnce([created])
    const pending = store().createSession('codex', '/p')
    await store().loadSessions()
    release(created)
    await pending
    expect(store().sessions.map((s) => s.id)).toEqual(['n'])
  })

  it('overlays a live session update on an older list response and keeps unseen sessions', async () => {
    let release: (v: Session[]) => void = () => {}
    ;(api.listSessions as Mock).mockReturnValueOnce(new Promise((r) => (release = r)))
    const pending = store().loadSessions()
    const updated: Session = { id: 'a', agent: 'codex', cwd: '/p', status: 'idle' }
    store().applyIncoming(event({ type: 'session.state', session: updated }))
    release([{ ...updated, status: 'running' }, { ...updated, id: 'b' }])
    await pending
    expect(store().sessions).toEqual([updated, { ...updated, id: 'b' }])
  })

  it('does not resurrect a resolved request from an older list response', async () => {
    let release: (v: SessionRequest[]) => void = () => {}
    ;(api.listRequests as Mock).mockReturnValueOnce(new Promise((r) => (release = r)))
    const pending = store().loadRequests()
    const request: SessionRequest = { id: 'r1', sessionId: 'a', kind: 'permission', state: 'pending' }
    store().applyIncoming(event({ type: 'request.resolved', request: { ...request, state: 'resolved' } }))
    release([request, { ...request, id: 'r2' }])
    await pending
    expect(store().pendingRequests.map((r) => r.id)).toEqual(['r2'])
  })

  it('keeps a live quota when an older HTTP quota snapshot arrives', async () => {
    let release: (v: QuotaSnapshot[]) => void = () => {}
    ;(api.getQuotas as Mock).mockReturnValueOnce(new Promise((r) => (release = r)))
    const pending = store().loadQuotas()
    const quota: QuotaSnapshot = { agent: 'codex', windows: [{ name: 'primary', usedPct: 90 }] }
    store().applyIncoming(event({ type: 'quota', quota }))
    release([{ ...quota, windows: [{ name: 'primary', usedPct: 10 }] }])
    await pending
    expect(store().quotas).toEqual([quota])
  })

  it('ignores a list response superseded by a later reload', async () => {
    let release: (v: Session[]) => void = () => {}
    ;(api.listSessions as Mock)
      .mockReturnValueOnce(new Promise((r) => (release = r)))
      .mockResolvedValueOnce([{ id: 'new' }])
    const pending = store().loadSessions()
    await store().loadSessions()
    release([])
    await pending
    expect(store().sessions.map((s) => s.id)).toEqual(['new'])
  })

  it('ignores an error from a superseded list reload', async () => {
    let reject: (e: Error) => void = () => {}
    ;(api.listSessions as Mock)
      .mockReturnValueOnce(new Promise((_, r) => (reject = r)))
      .mockResolvedValueOnce([])
    const pending = store().loadSessions()
    await store().loadSessions()
    reject(new Error('stale'))
    await pending
    expect(lastError()).toBeNull()
  })

  it('keeps requests opened during a list reload', async () => {
    let release: (v: SessionRequest[]) => void = () => {}
    ;(api.listRequests as Mock).mockReturnValueOnce(new Promise((r) => (release = r)))
    const pending = store().loadRequests()
    const request: SessionRequest = { id: 'r1', sessionId: 'a', kind: 'permission', state: 'pending' }
    store().applyIncoming(event({ type: 'request.opened', request }))
    release([])
    await pending
    expect(store().pendingRequests).toEqual([request])
  })

  it('ignores in-flight list responses after resetting the store', async () => {
    let release: (v: Session[]) => void = () => {}
    ;(api.listSessions as Mock).mockReturnValueOnce(new Promise((r) => (release = r)))
    const pending = store().loadSessions()
    resetStore()
    release([{ id: 'old', agent: 'codex', cwd: '/p', status: 'idle' }])
    await pending
    expect(store().sessions).toEqual([])
  })

  it('loads sessions', async () => {
    ;(api.listSessions as Mock).mockResolvedValue([{ id: 'a' }, { id: 'b' }])
    await store().loadSessions()
    expect(store().sessions.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('tells a loading session list from an empty one', async () => {
    let release: (v: Session[]) => void = () => {}
    ;(api.listSessions as Mock).mockReturnValueOnce(new Promise((r) => (release = r)))
    expect(store().sessionsStatus).toBe('loading')
    const pending = store().loadSessions()
    release([])
    await pending
    expect(store().sessionsStatus).toBe('ready')
  })

  it('marks the session list failed only before it ever loaded', async () => {
    ;(api.listSessions as Mock).mockRejectedValueOnce(new Error('down'))
    await store().loadSessions()
    expect(store().sessionsStatus).toBe('error')
    ;(api.listSessions as Mock).mockResolvedValueOnce([])
    await store().loadSessions()
    expect(store().sessionsStatus).toBe('ready')
    expect(lastError()).toBeNull()
    ;(api.listSessions as Mock).mockRejectedValueOnce(new Error('blip'))
    await store().loadSessions()
    expect(store().sessionsStatus).toBe('ready')
  })

  it('does not let a later success hide an unread error', async () => {
    ;(api.renameSession as Mock).mockRejectedValueOnce(new Error('rename broke'))
    await store().renameSession('a', 'x')
    ;(api.getQuotas as Mock).mockResolvedValueOnce([])
    await store().loadQuotas()
    expect(lastError()).toBe('rename broke')
  })

  it('reselecting the open session keeps its transcript', async () => {
    ;(api.fetchEvents as Mock).mockResolvedValueOnce([event({ seq: 1 })])
    await store().selectSession('a')
    useSessionStore.setState({ pane: 'sessions' })
    await store().selectSession('a')
    expect(api.fetchEvents).toHaveBeenCalledTimes(1)
    expect(store().chat.order).toEqual(['i1'])
    expect(store().pane).toBe('chat')
  })

  it('tracks the transcript load', async () => {
    let reject: (e: Error) => void = () => {}
    ;(api.fetchEvents as Mock).mockReturnValueOnce(new Promise((_, r) => (reject = r)))
    const pending = store().selectSession('a')
    expect(store().history).toBe('loading')
    reject(new Error('gone'))
    await pending
    expect(store().history).toBe('error')
    expect(lastError()).toBe('gone')
    ;(api.fetchEvents as Mock).mockResolvedValueOnce([])
    await store().selectSession('a')
    expect(store().history).toBe('ready')
    expect(lastError()).toBeNull()
  })

  it('returns whether an action went through', async () => {
    ;(api.respondRequest as Mock).mockResolvedValueOnce(undefined)
    expect(await store().respond('a', 'r1', { behavior: 'allow' })).toBe(true)
    ;(api.respondRequest as Mock).mockRejectedValueOnce(new Error('gone'))
    expect(await store().respond('a', 'r1', { behavior: 'allow' })).toBe(false)
  })

  it('flags a message search in flight', async () => {
    let release: (v: SearchHit[]) => void = () => {}
    ;(api.searchMessages as Mock).mockReturnValueOnce(new Promise((r) => (release = r)))
    const pending = store().searchMessages('needle')
    expect(store().searching).toBe(true)
    release([])
    await pending
    expect(store().searching).toBe(false)
  })

  it('asks for models again after a failed listing', async () => {
    ;(api.listModels as Mock).mockRejectedValueOnce(new Error('no')).mockResolvedValueOnce([{ id: 'm' }])
    await store().loadModels('claude')
    expect(store().models.claude).toEqual([])
    await store().loadModels('claude')
    expect(store().models.claude).toEqual([{ id: 'm' }])
  })

  it('records load errors', async () => {
    ;(api.listSessions as Mock).mockRejectedValue(new Error('down'))
    await store().loadSessions()
    expect(lastError()).toBe('down')
  })

  it('creates and selects a session', async () => {
    ;(api.createSession as Mock).mockResolvedValue({ id: 'new' })
    await store().createSession('claude', '/tmp/x')
    expect(api.createSession).toHaveBeenCalledWith('claude', '/tmp/x', undefined)
    expect(store().sessions.map((s) => s.id)).toContain('new')
    expect(store().activeId).toBe('new')
  })

  it('remembers group modes across reloads', () => {
    expect(store().groupModes).toEqual({})
    store().setGroupMode('/p', 'all')
    expect(store().groupModes).toEqual({ '/p': 'all' })
    expect(JSON.parse(localStorage.getItem('gc.groupModes')!)).toEqual({ '/p': 'all' })
    resetStore()
    expect(store().groupModes).toEqual({ '/p': 'all' })
  })

  it('ignores broken stored group modes', () => {
    localStorage.setItem('gc.groupModes', '{nope')
    resetStore()
    expect(store().groupModes).toEqual({})
    localStorage.setItem('gc.groupModes', '[1]')
    resetStore()
    expect(store().groupModes).toEqual({})
  })

  it('searches messages and drops stale answers', async () => {
    let resolveFirst: (v: unknown) => void = () => {}
    ;(api.searchMessages as Mock)
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce([{ sessionId: 's2', itemId: 'i', snippet: 'new', matches: 1 }])
    const first = store().searchMessages('old')
    await store().searchMessages('new')
    resolveFirst([{ sessionId: 's1', itemId: 'i', snippet: 'old', matches: 1 }])
    await first
    expect(store().searchHits.map((h) => h.sessionId)).toEqual(['s2'])
  })

  it('clears hits for short queries and on errors', async () => {
    useSessionStore.setState({ searchHits: [{ sessionId: 's', itemId: 'i', snippet: '', matches: 1 }] })
    await store().searchMessages(' a ')
    expect(store().searchHits).toEqual([])
    expect(api.searchMessages).not.toHaveBeenCalled()
    ;(api.searchMessages as Mock).mockRejectedValue(new Error('down'))
    useSessionStore.setState({ searchHits: [{ sessionId: 's', itemId: 'i', snippet: '', matches: 1 }] })
    await store().searchMessages('query')
    expect(store().searchHits).toEqual([])
  })

  it('loads models once per agent', async () => {
    ;(api.listModels as Mock).mockResolvedValue([{ id: 'opus', name: 'Opus' }])
    await store().loadModels('claude')
    await store().loadModels('claude')
    expect(api.listModels).toHaveBeenCalledTimes(1)
    expect(store().models.claude?.[0].id).toBe('opus')
  })

  it('keeps an empty catalog when models are unsupported', async () => {
    ;(api.listModels as Mock).mockRejectedValue(new Error('501'))
    await store().loadModels('codex')
    expect(store().models.codex).toEqual([])
  })

  it('sets a session model and remembers it for the agent', async () => {
    useSessionStore.setState({ sessions: [{ id: 'a', agent: 'codex', cwd: '/p', status: 'idle' }] })
    ;(api.setModel as Mock).mockResolvedValue({ id: 'a', agent: 'codex', cwd: '/p', status: 'idle', model: 'gpt', effort: 'high' })
    await store().setModel('a', { model: 'gpt', effort: 'high' })
    expect(api.setModel).toHaveBeenCalledWith('a', { model: 'gpt', effort: 'high' })
    expect(store().sessions[0].model).toBe('gpt')
    expect(JSON.parse(localStorage.getItem('gc.lastModel')!)).toEqual({ codex: { model: 'gpt', effort: 'high' } })

    ;(api.createSession as Mock).mockResolvedValue({ id: 'n', agent: 'codex', cwd: '/q', status: 'detached' })
    await store().createSession('codex', '/q')
    expect(api.createSession).toHaveBeenCalledWith('codex', '/q', { model: 'gpt', effort: 'high' })
    await store().createSession('claude', '/q')
    expect(api.createSession).toHaveBeenLastCalledWith('claude', '/q', undefined)
  })

  it('reports model errors', async () => {
    ;(api.setModel as Mock).mockRejectedValue(new Error('bad model'))
    await store().setModel('a', { model: 'x y', effort: '' })
    expect(lastError()).toBe('bad model')
  })

  it('keeps the session search query', () => {
    store().setQuery('picker')
    expect(store().query).toBe('picker')
  })

  it('starts on the sessions pane and switches panes', () => {
    expect(store().pane).toBe('sessions')
    store().setPane('requests')
    expect(store().pane).toBe('requests')
  })

  it('opens the chat pane when a session is selected', async () => {
    store().setPane('requests')
    await store().selectSession('a')
    expect(store().pane).toBe('chat')
  })

  it('applies history on select', async () => {
    ;(api.fetchEvents as Mock).mockResolvedValue([
      event({ seq: 1, item: item({ id: 'x', text: 'hi' }) }),
    ])
    await store().selectSession('a')
    expect(store().activeId).toBe('a')
    expect(store().chat.order).toEqual(['x'])
    store().applyIncoming(event({ seq: 2, item: item({ id: 'y' }) }))
    expect(store().chat.order).toEqual(['x', 'y'])
  })

  it('records select errors', async () => {
    ;(api.fetchEvents as Mock).mockRejectedValue(new Error('nope'))
    await store().selectSession('a')
    expect(lastError()).toBe('nope')
  })

  it('buffers live events while history loads, then flushes them', async () => {
    let release: (v: SessionEvent[]) => void = () => {}
    ;(api.fetchEvents as Mock).mockReturnValue(new Promise((r) => (release = r)))
    const pending = store().selectSession('a')
    store().applyIncoming(event({ seq: 2, item: item({ id: 'live' }) }))
    release([event({ seq: 1, item: item({ id: 'old' }) })])
    await pending
    expect(store().chat.order).toEqual(['old', 'live'])
    expect(api.fetchEvents).toHaveBeenCalledTimes(1)
  })

  it('keeps contiguous live events when history loading fails', async () => {
    let reject: (e: Error) => void = () => {}
    ;(api.fetchEvents as Mock).mockReturnValueOnce(new Promise((_, r) => (reject = r)))
    const pending = store().selectSession('a')
    store().applyIncoming(event({ seq: 1, item: item({ id: 'live' }) }))
    reject(new Error('offline'))
    await pending
    expect(store().chat.order).toEqual(['live'])
    expect(store().chat.lastSeq).toBe(1)
    expect(lastError()).toBe('offline')
  })

  it('retries failed history without skipping a gap before buffered live events', async () => {
    vi.useFakeTimers()
    try {
      let reject: (e: Error) => void = () => {}
      ;(api.fetchEvents as Mock)
        .mockReturnValueOnce(new Promise((_, r) => (reject = r)))
        .mockResolvedValueOnce([event({ seq: 1, item: item({ id: 'old' }) })])
      const pending = store().selectSession('a')
      store().applyIncoming(event({ seq: 2, item: item({ id: 'live' }) }))
      reject(new Error('offline'))
      await pending
      expect(store().chat.lastSeq).toBe(0)
      await vi.advanceTimersByTimeAsync(1000)
      expect(api.fetchEvents).toHaveBeenLastCalledWith('a', 0)
      expect(store().chat.order).toEqual(['old', 'live'])
      expect(lastError()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a failed history retry when another session is selected', async () => {
    vi.useFakeTimers()
    try {
      let reject: (e: Error) => void = () => {}
      ;(api.fetchEvents as Mock).mockReturnValueOnce(new Promise((_, r) => (reject = r)))
      const pending = store().selectSession('a')
      store().applyIncoming(event({ seq: 2, item: item({ id: 'live' }) }))
      reject(new Error('offline'))
      await pending
      await store().selectSession('b')
      await vi.advanceTimersByTimeAsync(1000)
      expect(api.fetchEvents).toHaveBeenCalledTimes(2)
      expect(store().activeId).toBe('b')
      expect(store().chat.order).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('retains the gap-triggering event when its history fetch fails', async () => {
    vi.useFakeTimers()
    try {
      await store().selectSession('a')
      ;(api.fetchEvents as Mock)
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce([event({ seq: 1, item: item({ id: 'old' }) })])
      store().applyIncoming(event({ seq: 2, item: item({ id: 'final' }) }))
      await vi.advanceTimersByTimeAsync(0)
      expect(store().chat.lastSeq).toBe(0)
      await vi.advanceTimersByTimeAsync(1000)
      expect(api.fetchEvents).toHaveBeenCalledTimes(3)
      expect(store().chat.order).toEqual(['old', 'final'])
      expect(store().chat.lastSeq).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores incoming events for other sessions and without an active session', () => {
    store().applyIncoming(event({ sessionId: 'b' }))
    expect(store().chat.order).toEqual([])
    useSessionStore.setState({ activeId: 'a' })
    store().applyIncoming(event({ sessionId: 'b' }))
    expect(store().chat.order).toEqual([])
    store().applyIncoming(event({ sessionId: 'a' }))
    expect(store().chat.order).toEqual(['i1'])
  })

  it('sends a message and clears it from the composer', async () => {
    useSessionStore.setState({ activeId: 'a' })
    await store().send('hello')
    expect(api.sendMessage).toHaveBeenCalledWith('a', 'hello')
  })

  it('does nothing on send without an active session or blank text', async () => {
    await store().send('hello')
    useSessionStore.setState({ activeId: 'a' })
    await store().send('   ')
    expect(api.sendMessage).not.toHaveBeenCalled()
  })

  it('steers the active session', async () => {
    useSessionStore.setState({ activeId: 'a' })
    await store().steer('more')
    expect(api.steer).toHaveBeenCalledWith('a', 'more')
    await store().steer('  ')
    expect(api.steer).toHaveBeenCalledTimes(1)
  })

  it('renames a session and keeps the server copy', async () => {
    useSessionStore.setState({ sessions: [{ id: 'a', agent: 'claude', cwd: '/p', status: 'idle', title: 'old' }] })
    ;(api.renameSession as Mock).mockResolvedValue({ id: 'a', agent: 'claude', cwd: '/p', status: 'idle', title: 'Notes' })
    await store().renameSession('a', 'Notes')
    expect(api.renameSession).toHaveBeenCalledWith('a', 'Notes')
    expect(store().sessions[0].title).toBe('Notes')
  })

  it('sets the approval reviewer and updates the session', async () => {
    useSessionStore.setState({ sessions: [{ id: 'a', agent: 'codex', cwd: '/p', status: 'idle' }] })
    ;(api.setApprovalReviewer as Mock).mockResolvedValue({ id: 'a', agent: 'codex', cwd: '/p', status: 'idle', approvalReviewer: 'user' })
    await store().setApprovalReviewer('a', 'user')
    expect(api.setApprovalReviewer).toHaveBeenCalledWith('a', 'user')
    expect(store().sessions[0].approvalReviewer).toBe('user')
    expect(lastError()).toBeNull()
  })

  it('reports approval reviewer errors', async () => {
    ;(api.setApprovalReviewer as Mock).mockRejectedValue(new Error('nope'))
    await store().setApprovalReviewer('a', 'user')
    expect(lastError()).toBe('nope')
  })

  it('stops a background task', async () => {
    await store().stopTask('a', 'task-1')
    expect(api.stopTask).toHaveBeenCalledWith('a', 'task-1')
    ;(api.stopTask as Mock).mockRejectedValue(new Error('nope'))
    await store().stopTask('a', 'task-1')
    expect(lastError()).toBe('nope')
  })

  it('reports send and interrupt errors', async () => {
    useSessionStore.setState({ activeId: 'a' })
    ;(api.sendMessage as Mock).mockRejectedValue(new Error('send failed'))
    await store().send('x')
    expect(lastError()).toBe('send failed')
    ;(api.interrupt as Mock).mockRejectedValue(new Error('stop failed'))
    await store().interrupt()
    expect(lastError()).toBe('stop failed')
  })

  it('interrupts the active session', async () => {
    useSessionStore.setState({ activeId: 'a' })
    await store().interrupt()
    expect(api.interrupt).toHaveBeenCalledWith('a')
  })

  it('ignores interrupt without an active session', async () => {
    await store().interrupt()
    expect(api.interrupt).not.toHaveBeenCalled()
  })

  it('connects a websocket and flips connection state', async () => {
    const instances: FakeSocket[] = []
    class FakeSocket {
      url: string
      onopen: (() => void) | null = null
      onclose: (() => void) | null = null
      onerror: (() => void) | null = null
      onmessage: ((m: { data: string }) => void) | null = null
      constructor(url: string) {
        this.url = url
        instances.push(this)
      }
      send() {}
      close() {}
    }
    vi.stubGlobal('WebSocket', FakeSocket)
    const pending = store().selectSession('a')
    const ws = instances[0]!
    expect(store().connection).toBe('connecting')
    expect(ws.url).toBe(`ws://${location.host}/api/ws`)
    ws.onopen?.()
    expect(store().connection).toBe('online')
    await pending
    ws.onmessage?.({ data: JSON.stringify(event({ seq: 1 })) })
    expect(store().chat.order).toEqual(['i1'])
    ws.onmessage?.({ data: 'not json' })
    ws.onerror?.()
    expect(store().connection).toBe('offline')
  })
})

describe('request handling', () => {
  it('loads pending requests', async () => {
    ;(api.listRequests as Mock).mockResolvedValue([{ id: 'r1' }])
    await store().loadRequests()
    expect(store().pendingRequests.map((r) => r.id)).toEqual(['r1'])
  })

  it('loads quotas', async () => {
    ;(api.getQuotas as Mock).mockResolvedValue([{ agent: 'codex', windows: [] }])
    await store().loadQuotas()
    expect(store().quotas.map((q) => q.agent)).toEqual(['codex'])
  })

  it('upserts quotas from live events', () => {
    store().applyIncoming({ seq: 1, sessionId: 'a', type: 'quota', quota: { agent: 'codex', windows: [{ name: 'primary', usedPct: 10 }] } })
    store().applyIncoming({ seq: 2, sessionId: 'a', type: 'quota', quota: { agent: 'codex', windows: [{ name: 'primary', usedPct: 20 }] } })
    expect(store().quotas).toHaveLength(1)
    expect(store().quotas[0]!.windows[0]!.usedPct).toBe(20)
  })

  it('records load-request errors', async () => {
    ;(api.listRequests as Mock).mockRejectedValue(new Error('nope'))
    await store().loadRequests()
    expect(lastError()).toBe('nope')
  })

  it('answers a request', async () => {
    await store().respond('a', 'r1', { behavior: 'allow' })
    expect(api.respondRequest).toHaveBeenCalledWith('a', 'r1', { behavior: 'allow' })
  })

  it('reports respond errors', async () => {
    ;(api.respondRequest as Mock).mockRejectedValue(new Error('gone'))
    await store().respond('a', 'r1', { behavior: 'allow' })
    expect(lastError()).toBe('gone')
  })

  it('tracks pending requests across sessions from live events', () => {
    useSessionStore.setState({ activeId: 'a' })
    store().applyIncoming({
      seq: 1, sessionId: 'b', type: 'request.opened',
      request: { id: 'r1', sessionId: 'b', kind: 'permission', state: 'pending' },
    })
    expect(store().pendingRequests.map((r) => r.id)).toEqual(['r1'])
    expect(store().chat.requests).toEqual({})

    store().applyIncoming({ seq: 2, sessionId: 'b', type: 'request.resolved', request: { id: 'r1', sessionId: 'b', kind: 'permission', state: 'resolved' } })
    expect(store().pendingRequests).toEqual([])

    store().applyIncoming({
      seq: 1, sessionId: 'a', type: 'request.opened',
      request: { id: 'r2', sessionId: 'a', kind: 'question', state: 'pending' },
    })
    expect(Object.keys(store().chat.requests)).toEqual(['r2'])
  })

  it('hands every live event to the chimes', () => {
    const opened = { seq: 1, sessionId: 'b', type: 'request.opened' as const, request: { id: 'r9', sessionId: 'b', kind: 'permission' as const, state: 'pending' as const } }
    store().applyIncoming(opened)
    expect(chimeOnEvent).toHaveBeenCalledWith(opened)
  })

  // Agents number requests per session: perm_3 in one session is not perm_3 in another.
  it('keeps same-id requests of different sessions apart', async () => {
    const req = (sessionId: string) => ({ id: 'perm_3', sessionId, kind: 'permission' as const, state: 'pending' as const })
    store().applyIncoming({ seq: 1, sessionId: 'a', type: 'request.opened', request: req('a') })
    store().applyIncoming({ seq: 1, sessionId: 'b', type: 'request.opened', request: req('b') })
    expect(store().pendingRequests.map((r) => r.sessionId)).toEqual(['a', 'b'])

    store().applyIncoming({ seq: 2, sessionId: 'b', type: 'request.resolved', request: { ...req('b'), state: 'resolved' } })
    expect(store().pendingRequests.map((r) => r.sessionId)).toEqual(['a'])

    ;(api.listRequests as Mock).mockResolvedValue([req('a'), req('c')])
    await store().loadRequests()
    expect(store().pendingRequests.map((r) => r.sessionId)).toEqual(['a', 'c'])
  })
})

// fakeServer models the backend hub: an append-only per-session log served by
// fetchEvents, and a WebSocket that only receives events published after it
// has opened (the server subscribes on upgrade, not before).
function fakeServer() {
  const log: SessionEvent[] = []
  const sockets: FakeWS[] = []
  class FakeWS {
    open = false
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    onmessage: ((m: { data: string }) => void) | null = null
    constructor() {
      sockets.push(this)
    }
    send() {}
    close() {}
  }
  vi.stubGlobal('WebSocket', FakeWS)
  ;(api.fetchEvents as Mock).mockImplementation(async (id: string, since: number) =>
    log.filter((e) => e.sessionId === id && e.seq > since),
  )
  return {
    publish(over: Partial<SessionEvent>, opts: { drop?: boolean } = {}) {
      const ev = event({ seq: log.filter((e) => e.sessionId === (over.sessionId ?? 'a')).length + 1, ...over })
      log.push(ev)
      if (opts.drop) return
      for (const ws of sockets) if (ws.open) ws.onmessage?.({ data: JSON.stringify(ev) })
    },
    openSocket() {
      const ws = sockets[0]!
      ws.open = true
      ws.onopen?.()
    },
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('live stream consistency', () => {
  it('catches up on events published before the websocket subscribed', async () => {
    const server = fakeServer()
    server.publish({ type: 'session.state', session: { id: 'a', status: 'idle' } as never, item: undefined })
    await store().selectSession('a')

    // The user sends before the socket handshake completes: these are lost to
    // the socket and were not in the history snapshot.
    server.publish({ item: item({ id: 'user', kind: 'user_message', text: 'hello' }) })
    server.publish({ item: item({ id: 'reply', text: 'echo: hello' }) })
    server.openSocket()
    server.publish({ type: 'usage', usage: { inputTokens: 22 } as never, item: undefined })
    server.publish({ type: 'turn.ended', item: undefined })
    await settle()

    expect(store().chat.order).toEqual(['user', 'reply'])
    expect(store().chat.status).toBe('idle')
    expect(store().chat.usage).toBeDefined()
  })

  it('catches up when the socket opens even if no later event reveals a gap', async () => {
    const server = fakeServer()
    await store().selectSession('a')
    server.publish({ item: item({ id: 'user' }) })
    server.publish({ type: 'turn.ended', item: undefined })
    server.openSocket()
    await settle()

    expect(store().chat.order).toEqual(['user'])
    expect(store().chat.status).toBe('idle')
  })

  it('ignores errors from a superseded history fetch', async () => {
    let reject: (e: Error) => void = () => {}
    ;(api.fetchEvents as Mock)
      .mockReturnValueOnce(new Promise((_, r) => (reject = r)))
      .mockResolvedValueOnce([])
    const first = store().selectSession('a')
    await store().selectSession('b')
    reject(new Error('stale'))
    await first
    expect(lastError()).toBeNull()
  })

  it('refetches missing events when the live stream skips a sequence number', async () => {
    const server = fakeServer()
    const selected = store().selectSession('a')
    server.openSocket()
    await selected
    await settle()
    server.publish({ item: item({ id: 'one' }) })
    server.publish({ item: item({ id: 'two' }) }, { drop: true })
    server.publish({ item: item({ id: 'three' }) })
    await settle()

    expect(store().chat.order).toEqual(['one', 'two', 'three'])
    expect(api.fetchEvents).toHaveBeenLastCalledWith('a', 1)
  })

  it('does not let a stale history response overwrite a newer selection', async () => {
    const releases: Record<string, (v: SessionEvent[]) => void> = {}
    ;(api.fetchEvents as Mock).mockImplementation(
      (id: string) => new Promise((r) => (releases[id] = r)),
    )
    const first = store().selectSession('a')
    const second = store().selectSession('b')
    releases.b!([event({ sessionId: 'b', item: item({ id: 'from-b', sessionId: 'b' }) })])
    await second
    releases.a!([event({ seq: 2, item: item({ id: 'from-a' }) })])
    await first

    expect(store().activeId).toBe('b')
    expect(store().chat.order).toEqual(['from-b'])
    expect(lastError()).toBeNull()
  })
})

describe('audit fixes', () => {
  it('replaces the session so cleared fields do not linger', async () => {
    useSessionStore.setState({ sessions: [{ id: 'a', agent: 'claude', cwd: '/p', status: 'idle', model: 'haiku', effort: 'low' } as never] })
    ;(api.setModel as Mock).mockResolvedValue({ id: 'a', agent: 'claude', cwd: '/p', status: 'idle' })
    await store().setModel('a', { model: '', effort: '' })
    expect(store().sessions[0]!.model).toBeUndefined()
    expect(store().sessions[0]!.effort).toBeUndefined()

    useSessionStore.setState({ sessions: [{ id: 'a', agent: 'claude', cwd: '/p', status: 'interrupted', interruption: { reason: 'crashed' } } as never] })
    store().applyIncoming({ seq: 1, sessionId: 'a', type: 'session.state', session: { id: 'a', agent: 'claude', cwd: '/p', status: 'idle' } as never })
    expect(store().sessions[0]!.interruption).toBeUndefined()
  })

  it('does not let a superseded resync drop the newer one\'s buffer', async () => {
    const server = fakeServer()
    const releases: (() => void)[] = []
    ;(api.fetchEvents as Mock).mockImplementation(
      (_id: string, since: number) =>
        new Promise((r) => releases.push(() => r([]))).then(() => [] as SessionEvent[]).then(() => {
          void since
          return []
        }),
    )
    const selected = store().selectSession('a')
    server.openSocket()
    releases[0]!()
    await selected
    // the second resync is still in flight: a live event must be buffered.
    server.publish({ item: item({ id: 'late' }), seq: 1 })
    expect(store().chat.order).toEqual([])
    releases[1]!()
    await settle()
    expect(store().chat.order).toEqual(['late'])
    expect(api.fetchEvents).toHaveBeenCalledTimes(2)
  })

  it('reloads requests and quotas when the stream skips events', async () => {
    const server = fakeServer()
    ;(api.listRequests as Mock).mockResolvedValue([])
    ;(api.getQuotas as Mock).mockResolvedValue([])
    const selected = store().selectSession('a')
    server.openSocket()
    await selected
    await settle()
    vi.clearAllMocks()
    ;(api.listRequests as Mock).mockResolvedValue([])
    ;(api.getQuotas as Mock).mockResolvedValue([])
    ;(api.fetchEvents as Mock).mockResolvedValue([])
    // another session's stream skips seq 2
    server.publish({ sessionId: 'b', item: item({ id: 'b1', sessionId: 'b' }) })
    server.publish({ sessionId: 'b', item: item({ id: 'b2', sessionId: 'b' }) }, { drop: true })
    server.publish({ sessionId: 'b', item: item({ id: 'b3', sessionId: 'b' }) })
    await settle()
    expect(api.listRequests).toHaveBeenCalled()
    expect(api.getQuotas).toHaveBeenCalled()
  })

  it('keeps the event socket open without a session and reconnects after it drops', async () => {
    vi.useFakeTimers()
    try {
      const sockets: { onopen: (() => void) | null; onclose: (() => void) | null }[] = []
      class FakeWS {
        onopen: (() => void) | null = null
        onclose: (() => void) | null = null
        onerror: (() => void) | null = null
        onmessage: ((m: { data: string }) => void) | null = null
        constructor() {
          sockets.push(this)
        }
        close() {}
      }
      vi.stubGlobal('WebSocket', FakeWS)
      ;(api.listSessions as Mock).mockResolvedValue([])
      ;(api.listRequests as Mock).mockResolvedValue([])
      ;(api.getQuotas as Mock).mockResolvedValue([])
      store().connect()
      expect(sockets).toHaveLength(1)
      sockets[0]!.onopen?.()
      sockets[0]!.onclose?.()
      expect(store().connection).toBe('offline')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(sockets).toHaveLength(2)
      vi.clearAllMocks()
      ;(api.listSessions as Mock).mockResolvedValue([])
      ;(api.listRequests as Mock).mockResolvedValue([])
      ;(api.getQuotas as Mock).mockResolvedValue([])
      sockets[1]!.onopen?.()
      expect(store().connection).toBe('online')
      expect(api.listSessions).toHaveBeenCalled()
      expect(api.listRequests).toHaveBeenCalled()
      expect(api.getQuotas).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('coalesces text deltas and flushes them before other events', async () => {
    vi.useFakeTimers()
    try {
      resetDiagnostics()
      beginAgentView('a')
      vi.advanceTimersByTime(50)
      useSessionStore.setState({ activeId: 'a' })
      store().applyIncoming(event({ seq: 1, item: item({ id: 'i1', text: '' }) }))
      store().applyIncoming(event({ seq: 2, type: 'text.delta', item: undefined, delta: { itemId: 'i1', text: 'he' } }))
      vi.advanceTimersByTime(25)
      store().applyIncoming(event({ seq: 3, type: 'text.delta', item: undefined, delta: { itemId: 'i1', text: 'llo' } }))
      expect(store().chat.items.i1!.text).toBe('')
      await vi.advanceTimersByTimeAsync(75)
      expect(store().chat.items.i1!.text).toBe('hello')
      expect(diagnostics().metrics.agentBatch.last).toBe(100)
      expect(diagnostics().agent).toEqual({ events: 3, batches: 2, batchSize: 2 })
      recordAgentCommit('a')
      expect(diagnostics().metrics.agentCommit.count).toBe(1)
      store().applyIncoming(event({ seq: 4, type: 'text.delta', item: undefined, delta: { itemId: 'i1', text: '!' } }))
      store().applyIncoming(event({ seq: 5, type: 'turn.ended', item: undefined }))
      expect(store().chat.items.i1!.text).toBe('hello!')
      expect(store().chat.lastSeq).toBe(5)
    } finally {
      endAgentView('a')
      vi.useRealTimers()
    }
  })
})

describe('failures shown in place', () => {
  const toasts = () => useNotices.getState().notices

  it('leaves a first failed session load to the list, but toasts a failed refresh', async () => {
    ;(api.listSessions as Mock).mockRejectedValueOnce(new Error('down'))
    await store().loadSessions()
    expect(store().sessionsStatus).toBe('error')
    expect(toasts()).toEqual([])
    expect(lastError()).toBe('down')
    ;(api.listSessions as Mock).mockResolvedValueOnce([{ id: 'a' }])
    await store().loadSessions()
    ;(api.listSessions as Mock).mockRejectedValueOnce(new Error('blip'))
    await store().loadSessions()
    expect(toasts().map((n) => n.text)).toEqual(['blip'])
  })

  it('tracks the request inbox load and leaves a first failure to it', async () => {
    expect(store().requestsStatus).toBe('loading')
    ;(api.listRequests as Mock).mockRejectedValueOnce(new Error('nope'))
    await store().loadRequests()
    expect(store().requestsStatus).toBe('error')
    expect(toasts()).toEqual([])
    ;(api.listRequests as Mock).mockResolvedValueOnce([])
    await store().loadRequests()
    expect(store().requestsStatus).toBe('ready')
    expect(lastError()).toBeNull()
    ;(api.listRequests as Mock).mockRejectedValueOnce(new Error('blip'))
    await store().loadRequests()
    expect(store().requestsStatus).toBe('ready')
    expect(toasts().map((n) => n.text)).toEqual(['blip'])
  })

  it('shows a failed transcript only in the chat, with its reason', async () => {
    ;(api.fetchEvents as Mock).mockRejectedValueOnce(new Error('gone'))
    await store().selectSession('a')
    expect(store().history).toBe('error')
    expect(store().historyError).toEqual({ kind: 'failed', reason: 'gone' })
    expect(toasts()).toEqual([])
    ;(api.fetchEvents as Mock).mockResolvedValueOnce([])
    await store().selectSession('a')
    expect(store().historyError).toBeNull()
  })

  it('tells a session that is not there from a failed load', async () => {
    vi.useFakeTimers()
    try {
      ;(api.fetchEvents as Mock).mockRejectedValue(Object.assign(new Error('{"error":"session not found"}'), { status: 404 }))
      const pending = store().selectSession('a')
      store().applyIncoming(event({ seq: 2, item: item({ id: 'live' }) }))
      await pending
      expect(store().historyError?.kind).toBe('not_found')
      // a missing session is not retried on its own
      await vi.advanceTimersByTimeAsync(5000)
      expect(api.fetchEvents).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the transcript error when another session opens', async () => {
    ;(api.fetchEvents as Mock).mockRejectedValueOnce(new Error('gone'))
    await store().selectSession('a')
    let release: (v: SessionEvent[]) => void = () => {}
    ;(api.fetchEvents as Mock).mockReturnValueOnce(new Promise((r) => (release = r)))
    const pending = store().selectSession('b')
    expect(store().historyError).toBeNull()
    release([])
    await pending
  })

  it('leaves a failed answer to the request it belongs to', async () => {
    ;(api.respondRequest as Mock).mockRejectedValueOnce(new Error('gone'))
    expect(await store().respond('a', 'r1', { behavior: 'allow' })).toBe(false)
    expect(toasts()).toEqual([])
    expect(lastError()).toBe('gone')
  })

  it('leaves a failed history import to the history panel', async () => {
    ;(api.importHistory as Mock).mockRejectedValueOnce(new Error('thread is gone'))
    expect(await store().importHistory('codex', 't1')).toBe(false)
    expect(toasts()).toEqual([])
    expect(lastError()).toBe('thread is gone')
  })
})
