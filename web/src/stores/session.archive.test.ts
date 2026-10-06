import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Session, SessionEvent, SessionRequest } from '../lib/api'

vi.mock('../lib/api', () => ({
  listSessions: vi.fn(),
  listRequests: vi.fn(),
  getQuotas: vi.fn(),
  fetchEvents: vi.fn(),
  archiveSession: vi.fn(),
  unarchiveSession: vi.fn(),
  deleteSession: vi.fn(),
}))

vi.mock('../lib/chime', () => ({ chimeOnEvent: vi.fn() }))

import * as api from '../lib/api'
import { resetStore, useSessionStore } from './session'
import { resetNotices, useNotices } from './notices'

const store = () => useSessionStore.getState()

const session = (id: string, over: Partial<Session> = {}): Session => ({ id, agent: 'claude', cwd: '/p', status: 'idle', ...over })
const request = (id: string, sessionId: string): SessionRequest =>
  ({ id, sessionId, kind: 'permission', state: 'pending', title: 'Bash' }) as SessionRequest

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.stubGlobal('WebSocket', undefined)
  resetStore()
  resetNotices()
  history.replaceState(null, '', '/')
  ;(api.fetchEvents as Mock).mockResolvedValue([])
})

describe('archive', () => {
  it('archives and unarchives with the server copy', async () => {
    useSessionStore.setState({ sessions: [session('a'), session('b')] })
    ;(api.archiveSession as Mock).mockResolvedValue(session('a', { archivedAt: '2026-10-06T09:00:00Z' }))
    expect(await store().archiveSession('a')).toBe(true)
    expect(api.archiveSession).toHaveBeenCalledWith('a')
    expect(store().sessions[0]!.archivedAt).toBe('2026-10-06T09:00:00Z')

    ;(api.unarchiveSession as Mock).mockResolvedValue(session('a'))
    expect(await store().unarchiveSession('a')).toBe(true)
    expect(store().sessions[0]!.archivedAt).toBeUndefined()
  })

  it('says so when archiving fails', async () => {
    useSessionStore.setState({ sessions: [session('a')] })
    ;(api.archiveSession as Mock).mockRejectedValue(new Error('boom'))
    ;(api.unarchiveSession as Mock).mockRejectedValue(new Error('boom'))
    expect(await store().archiveSession('a')).toBe(false)
    expect(await store().unarchiveSession('a')).toBe(false)
    const titles = useNotices.getState().notices.map((n) => n.title)
    expect(titles).toEqual(expect.arrayContaining(["Couldn't archive the session", "Couldn't unarchive the session"]))
  })
})

describe('delete', () => {
  it('removes the session, its subagents and their requests', async () => {
    useSessionStore.setState({
      sessions: [session('a'), session('sub', { parentId: 'a' }), session('subsub', { parentId: 'sub' }), session('b')],
      pendingRequests: [request('r1', 'sub'), request('r2', 'b')],
    })
    ;(api.deleteSession as Mock).mockResolvedValue(undefined)
    expect(await store().deleteSession('a')).toBe(true)
    expect(api.deleteSession).toHaveBeenCalledWith('a')
    expect(store().sessions.map((s) => s.id)).toEqual(['b'])
    expect(store().pendingRequests.map((r) => r.id)).toEqual(['r2'])
  })

  it('leaves the deleted open session for the empty state', async () => {
    useSessionStore.setState({ sessions: [session('a'), session('b')] })
    await store().selectSession('a')
    history.replaceState(null, '', '/s/a?x=1')
    ;(api.deleteSession as Mock).mockResolvedValue(undefined)
    await store().deleteSession('a')
    expect(store().activeId).toBeNull()
    expect(store().pane).toBe('sessions')
    expect(location.pathname + location.search).toBe('/?x=1')
  })

  it('keeps the open session when another one is deleted', async () => {
    useSessionStore.setState({ sessions: [session('a'), session('b')] })
    await store().selectSession('b')
    history.replaceState(null, '', '/s/b')
    ;(api.deleteSession as Mock).mockResolvedValue(undefined)
    await store().deleteSession('a')
    expect(store().activeId).toBe('b')
    expect(location.pathname).toBe('/s/b')
  })

  it('keeps the session and says why when the server refuses', async () => {
    useSessionStore.setState({ sessions: [session('a', { status: 'running' })] })
    ;(api.deleteSession as Mock).mockRejectedValue(new Error('session is running: stop its turn first'))
    expect(await store().deleteSession('a')).toBe(false)
    expect(store().sessions).toHaveLength(1)
    const notice = useNotices.getState().notices[0]!
    expect(notice.title).toBe("Couldn't delete the session")
    expect(notice.text).toContain('stop its turn first')
  })

  it('drops a session another tab deleted', async () => {
    useSessionStore.setState({ sessions: [session('a'), session('b')], pendingRequests: [request('r1', 'a')] })
    await store().selectSession('a')
    const removed: SessionEvent = { seq: 9, sessionId: 'a', type: 'session.removed' }
    store().applyIncoming(removed)
    expect(store().sessions.map((s) => s.id)).toEqual(['b'])
    expect(store().pendingRequests).toEqual([])
    expect(store().activeId).toBeNull()
  })

  it('does not bring back a session deleted while the list loads', async () => {
    useSessionStore.setState({ sessions: [session('a'), session('b')] })
    let release: (v: Session[]) => void = () => {}
    ;(api.listSessions as Mock).mockReturnValueOnce(new Promise((r) => (release = r)))
    const loading = store().loadSessions()
    store().applyIncoming({ seq: 3, sessionId: 'a', type: 'session.removed' })
    release([session('a'), session('b')])
    await loading
    expect(store().sessions.map((s) => s.id)).toEqual(['b'])
  })
})
