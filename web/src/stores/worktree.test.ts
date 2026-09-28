import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('../lib/api', () => ({
  createSession: vi.fn(),
  createWorktreeSession: vi.fn(),
  fetchEvents: vi.fn().mockResolvedValue([]),
}))

import * as api from '../lib/api'
import { resetStore, useSessionStore } from './session'

const store = () => useSessionStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('WebSocket', undefined)
  resetStore()
})

describe('worktree sessions', () => {
  it('creates a session in a new worktree when a branch is given', async () => {
    ;(api.createWorktreeSession as Mock).mockResolvedValue({ id: 'wt', agent: 'claude', cwd: '/wt/app/fix', status: 'detached' })
    await store().createSession('claude', '/src/app', 'fix')
    expect(api.createWorktreeSession).toHaveBeenCalledWith('claude', '/src/app', 'fix', undefined)
    expect(api.createSession).not.toHaveBeenCalled()
    expect(store().activeId).toBe('wt')
  })

  it('reports a failed worktree', async () => {
    ;(api.createWorktreeSession as Mock).mockRejectedValue(new Error('not a git repository'))
    await store().createSession('claude', '/tmp', 'fix')
    expect(store().error).toBe('not a git repository')
  })
})
