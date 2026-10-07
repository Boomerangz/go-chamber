import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('../lib/api', () => ({
  listSessions: vi.fn(async () => []),
  listRequests: vi.fn(async () => []),
  getQuotas: vi.fn(async () => []),
  fetchEvents: vi.fn(async () => []),
  getSession: vi.fn(async () => ({ id: 'a', agent: 'claude', cwd: '/p', status: 'idle' })),
}))

import { chimesHere, presenceClient, resetPresence, setPresenceSession } from '../lib/presence'
import { resetStore, useSessionStore } from './session'

class FakeSocket {
  static last: FakeSocket
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((msg: { data: string }) => void) | null = null
  constructor() {
    FakeSocket.last = this
  }
  send(frame: string) {
    this.sent.push(frame)
  }
  close() {}
}

const store = () => useSessionStore.getState()

beforeEach(() => {
  resetPresence()
  resetStore()
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => {
  resetStore()
  vi.unstubAllGlobals()
})

describe('presence on the event socket', () => {
  it('says where this page is once the socket opens, and nothing once it closed', () => {
    store().connect()
    const ws = FakeSocket.last
    ws.onopen!()
    const first = JSON.parse(ws.sent[0]!) as { type: string; client: string }
    expect(first).toMatchObject({ type: 'presence', client: presenceClient() })
    ws.onclose!()
    setPresenceSession('a')
    expect(ws.sent).toHaveLength(1)
  })

  it('takes the server\'s word on where the owner is, apart from the events', () => {
    const apply = vi.fn()
    useSessionStore.setState({ applyIncoming: apply as Mock })
    store().connect()
    FakeSocket.last.onopen!()
    FakeSocket.last.onmessage!({ data: JSON.stringify({ type: 'presence', active: 'the-phone' }) })
    expect(chimesHere()).toBe(false)
    expect(apply).not.toHaveBeenCalled()
    FakeSocket.last.onmessage!({ data: JSON.stringify({ type: 'presence', active: presenceClient() }) })
    expect(chimesHere()).toBe(true)
  })
})
