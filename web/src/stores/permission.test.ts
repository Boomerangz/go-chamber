import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('../lib/api', () => ({
  fetchEvents: vi.fn(),
  createSession: vi.fn(),
  setPermissionMode: vi.fn(),
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

describe('permission mode', () => {
  it('switches the mode, keeps the server copy and reports errors', async () => {
    useSessionStore.setState({ sessions: [{ id: 'a', agent: 'claude', cwd: '/p', status: 'idle', permissionMode: 'plan' }] })
    ;(api.setPermissionMode as Mock).mockResolvedValue({ id: 'a', agent: 'claude', cwd: '/p', status: 'idle' })
    await store().setPermissionMode('a', '')
    expect(api.setPermissionMode).toHaveBeenCalledWith('a', '')
    expect(store().sessions[0].permissionMode).toBeUndefined()
    ;(api.setPermissionMode as Mock).mockRejectedValue(new Error('bypassPermissions mode is disabled'))
    await store().setPermissionMode('a', 'bypassPermissions')
    expect(store().error).toBe('bypassPermissions mode is disabled')
  })

  it('starts new sessions of the agent in the mode last chosen', async () => {
    useSessionStore.setState({ sessions: [{ id: 'a', agent: 'claude', cwd: '/p', status: 'idle' }] })
    ;(api.setPermissionMode as Mock).mockResolvedValue({ id: 'a', agent: 'claude', cwd: '/p', status: 'idle', permissionMode: 'acceptEdits' })
    await store().setPermissionMode('a', 'acceptEdits')
    ;(api.createSession as Mock).mockResolvedValue({ id: 'b', agent: 'claude', cwd: '/q', status: 'detached' })
    await store().createSession('claude', '/q')
    expect(api.createSession).toHaveBeenCalledWith('claude', '/q', expect.objectContaining({ permissionMode: 'acceptEdits' }))
    ;(api.createSession as Mock).mockClear()
    await store().createSession('codex', '/q')
    expect((api.createSession as Mock).mock.calls[0][2]?.permissionMode).toBeUndefined()
  })
})
