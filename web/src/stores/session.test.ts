import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Item, SessionEvent } from '../lib/api'

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
  interrupt: vi.fn(),
  respondRequest: vi.fn(),
  searchMessages: vi.fn(),
}))

import * as api from '../lib/api'
import { resetStore, useSessionStore } from './session'

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
  ;(api.fetchEvents as Mock).mockResolvedValue([])
})

describe('session store', () => {
  it('loads sessions', async () => {
    ;(api.listSessions as Mock).mockResolvedValue([{ id: 'a' }, { id: 'b' }])
    await store().loadSessions()
    expect(store().sessions.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('records load errors', async () => {
    ;(api.listSessions as Mock).mockRejectedValue(new Error('down'))
    await store().loadSessions()
    expect(store().error).toBe('down')
  })

  it('creates and selects a session', async () => {
    ;(api.createSession as Mock).mockResolvedValue({ id: 'new' })
    await store().createSession('claude', '/tmp/x')
    expect(api.createSession).toHaveBeenCalledWith('claude', '/tmp/x')
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

  it('keeps the session search query', () => {
    store().setQuery('picker')
    expect(store().query).toBe('picker')
  })

  it('starts on the sessions pane and switches panes', () => {
    expect(store().pane).toBe('sessions')
    store().setPane('terminal')
    expect(store().pane).toBe('terminal')
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
    expect(store().error).toBe('nope')
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

  it('sets the approval reviewer and updates the session', async () => {
    useSessionStore.setState({ sessions: [{ id: 'a', agent: 'codex', cwd: '/p', status: 'idle' }] })
    ;(api.setApprovalReviewer as Mock).mockResolvedValue({ id: 'a', agent: 'codex', cwd: '/p', status: 'idle', approvalReviewer: 'user' })
    await store().setApprovalReviewer('a', 'user')
    expect(api.setApprovalReviewer).toHaveBeenCalledWith('a', 'user')
    expect(store().sessions[0].approvalReviewer).toBe('user')
    expect(store().error).toBeNull()
  })

  it('reports approval reviewer errors', async () => {
    ;(api.setApprovalReviewer as Mock).mockRejectedValue(new Error('nope'))
    await store().setApprovalReviewer('a', 'user')
    expect(store().error).toBe('nope')
  })

  it('stops a background task', async () => {
    await store().stopTask('a', 'task-1')
    expect(api.stopTask).toHaveBeenCalledWith('a', 'task-1')
    ;(api.stopTask as Mock).mockRejectedValue(new Error('nope'))
    await store().stopTask('a', 'task-1')
    expect(store().error).toBe('nope')
  })

  it('reports send and interrupt errors', async () => {
    useSessionStore.setState({ activeId: 'a' })
    ;(api.sendMessage as Mock).mockRejectedValue(new Error('send failed'))
    await store().send('x')
    expect(store().error).toBe('send failed')
    ;(api.interrupt as Mock).mockRejectedValue(new Error('stop failed'))
    await store().interrupt()
    expect(store().error).toBe('stop failed')
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
    useSessionStore.setState({ activeId: 'a' })
    const pending = store().selectSession('a')
    const ws = instances[0]!
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
    expect(store().error).toBe('nope')
  })

  it('answers a request', async () => {
    await store().respond('a', 'r1', { behavior: 'allow' })
    expect(api.respondRequest).toHaveBeenCalledWith('a', 'r1', { behavior: 'allow' })
  })

  it('reports respond errors', async () => {
    ;(api.respondRequest as Mock).mockRejectedValue(new Error('gone'))
    await store().respond('a', 'r1', { behavior: 'allow' })
    expect(store().error).toBe('gone')
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
    expect(store().error).toBeNull()
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
    expect(store().error).toBeNull()
  })
})
