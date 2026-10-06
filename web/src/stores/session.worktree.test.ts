import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Session } from '../lib/api'

vi.mock('../lib/api', () => ({
  listSessions: vi.fn(),
  listRequests: vi.fn(),
  getQuotas: vi.fn(),
  fetchEvents: vi.fn(),
  createSession: vi.fn(),
  createWorktreeSession: vi.fn(),
  deleteSession: vi.fn(),
}))

vi.mock('../lib/chime', () => ({ chimeOnEvent: vi.fn() }))

import * as api from '../lib/api'
import { resetStore, useSessionStore } from './session'
import { lastError, resetNotices, useNotices } from './notices'

const store = () => useSessionStore.getState()
const session = (id: string, over: Partial<Session> = {}): Session => ({ id, agent: 'claude', cwd: '/p', status: 'idle', ...over })

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.stubGlobal('WebSocket', undefined)
  resetStore()
  resetNotices()
  ;(api.fetchEvents as Mock).mockResolvedValue([])
})

describe('worktree sessions', () => {
  it('leaves a refused worktree to the form to explain', async () => {
    ;(api.createWorktreeSession as Mock).mockRejectedValue(new Error('branch already exists: chamber/x'))
    expect(await store().createSession('claude', '/repo', 'x')).toBe(false)
    expect(useNotices.getState().notices).toEqual([])
    expect(lastError()).toBe('branch already exists: chamber/x')
  })

  it('still says out loud when a plain session fails to start', async () => {
    ;(api.createSession as Mock).mockRejectedValue(new Error('boom'))
    expect(await store().createSession('claude', '/repo')).toBe(false)
    expect(useNotices.getState().notices.at(-1)?.text).toBe('boom')
  })

  it('deletes a session with its worktree folder when asked', async () => {
    useSessionStore.setState({ sessions: [session('a'), session('b')] })
    ;(api.deleteSession as Mock).mockResolvedValue(undefined)
    expect(await store().deleteSession('a', { removeWorktree: true })).toBe(true)
    expect(api.deleteSession).toHaveBeenCalledWith('a', { removeWorktree: true })
    expect(store().sessions.map((s) => s.id)).toEqual(['b'])
    expect(await store().deleteSession('b')).toBe(true)
    expect(api.deleteSession).toHaveBeenLastCalledWith('b')
  })
})
