import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('../lib/api', () => ({
  fetchEvents: vi.fn(),
  continueSession: vi.fn(),
  setAutoContinue: vi.fn(),
  forkSession: vi.fn(),
}))

import * as api from '../lib/api'
import { resetStore, useSessionStore } from './session'

const store = () => useSessionStore.getState()

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.stubGlobal('WebSocket', undefined)
  resetStore()
  ;(api.fetchEvents as Mock).mockResolvedValue([])
})

describe('continue and fork', () => {
  it('continues the active session', async () => {
    useSessionStore.setState({ activeId: 'a' })
    await store().continueSession()
    expect(api.continueSession).toHaveBeenCalledWith('a')
    ;(api.continueSession as Mock).mockRejectedValue(new Error('nothing to continue'))
    await store().continueSession()
    expect(store().error).toBe('nothing to continue')
  })

  it('toggles auto-continue and keeps the server copy', async () => {
    useSessionStore.setState({ sessions: [{ id: 'a', agent: 'claude', cwd: '/p', status: 'interrupted' }] })
    ;(api.setAutoContinue as Mock).mockResolvedValue({ id: 'a', agent: 'claude', cwd: '/p', status: 'interrupted', autoContinue: true })
    await store().setAutoContinue('a', true)
    expect(api.setAutoContinue).toHaveBeenCalledWith('a', true)
    expect(store().sessions[0].autoContinue).toBe(true)
    ;(api.setAutoContinue as Mock).mockRejectedValue(new Error('no reset time'))
    await store().setAutoContinue('a', true)
    expect(store().error).toBe('no reset time')
  })

  it('forks into a new session and opens it', async () => {
    useSessionStore.setState({ sessions: [{ id: 'a', agent: 'claude', cwd: '/p', status: 'idle' }] })
    ;(api.forkSession as Mock).mockResolvedValue({ id: 'f', agent: 'claude', cwd: '/p', status: 'idle', forkOf: 'a' })
    await store().forkSession('a')
    expect(store().sessions.map((s) => s.id)).toEqual(['a', 'f'])
    expect(store().activeId).toBe('f')
    ;(api.forkSession as Mock).mockRejectedValue(new Error('fork before the first turn'))
    await store().forkSession('a')
    expect(store().error).toBe('fork before the first turn')
  })
})
