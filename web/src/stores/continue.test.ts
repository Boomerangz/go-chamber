import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('../lib/api', () => ({
  fetchEvents: vi.fn(),
  continueSession: vi.fn(),
  setAutoContinue: vi.fn(),
  forkSession: vi.fn(),
}))

import * as api from '../lib/api'
import { resetStore, useSessionStore } from './session'
import { lastError, resetNotices, useNotices } from './notices'

const store = () => useSessionStore.getState()

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.stubGlobal('WebSocket', undefined)
  resetStore()
  resetNotices()
  ;(api.fetchEvents as Mock).mockResolvedValue([])
})

describe('continue and fork', () => {
  it('continues the active session', async () => {
    useSessionStore.setState({ activeId: 'a' })
    await store().continueSession()
    expect(api.continueSession).toHaveBeenCalledWith('a')
    ;(api.continueSession as Mock).mockRejectedValue(new Error('nothing to continue'))
    await store().continueSession()
    expect(lastError()).toBe('nothing to continue')
    expect(useNotices.getState().notices.at(-1)?.title).toBe("Couldn't continue the session")
  })

  it('toggles auto-continue and keeps the server copy', async () => {
    useSessionStore.setState({ sessions: [{ id: 'a', agent: 'claude', cwd: '/p', status: 'interrupted' }] })
    ;(api.setAutoContinue as Mock).mockResolvedValue({ id: 'a', agent: 'claude', cwd: '/p', status: 'interrupted', autoContinue: true })
    await store().setAutoContinue('a', true)
    expect(api.setAutoContinue).toHaveBeenCalledWith('a', true)
    expect(store().sessions[0].autoContinue).toBe(true)
    ;(api.setAutoContinue as Mock).mockRejectedValue(new Error('no reset time'))
    await store().setAutoContinue('a', true)
    expect(lastError()).toBe('no reset time')
  })

  it('forks into a new session and opens it', async () => {
    useSessionStore.setState({ sessions: [{ id: 'a', agent: 'claude', cwd: '/p', status: 'idle' }] })
    ;(api.forkSession as Mock).mockResolvedValue({ id: 'f', agent: 'claude', cwd: '/p', status: 'idle', forkOf: 'a' })
    await store().forkSession('a')
    expect(store().sessions.map((s) => s.id)).toEqual(['a', 'f'])
    expect(store().activeId).toBe('f')
    ;(api.forkSession as Mock).mockRejectedValue(new Error('fork before the first turn'))
    await store().forkSession('a')
    expect(lastError()).toBe('fork before the first turn')
  })
})

it('passes the selected agent to fork and opens the new session', async () => {
 ;(api.forkSession as Mock).mockResolvedValue({ id: 'f', agent: 'codex', cwd: '/p', status: 'running', forkOf: 'a' })
 await store().forkSession('a', 'codex')
 expect(api.forkSession).toHaveBeenCalledWith('a', 'codex')
 expect(store().activeId).toBe('f')
 expect(store().sessions[0].agent).toBe('codex')
})
