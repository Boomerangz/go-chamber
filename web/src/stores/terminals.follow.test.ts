import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Session } from '../lib/api'
import type { Terminal } from '../lib/terminal'

vi.mock('../lib/terminal', () => ({
  listTerminals: vi.fn(),
  openTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  renameTerminal: vi.fn(),
}))

import * as api from '../lib/terminal'
import { useSessionStore } from './session'
import { followSessions, resetTerminals, useTerminalStore } from './terminals'

const term = (id: string, cwd: string): Terminal => ({ id, cwd, shell: '/bin/sh', title: id, status: 'running', exitCode: 0, createdAt: '' })
const wt = { repo: '/src/app', path: '/wt/app/fix', branch: 'chamber/fix', base: 'b' }
const session = (id: string, worktree?: Session['worktree']): Session =>
  ({ id, agent: 'claude', cwd: worktree?.path ?? '/src/app', status: 'idle', createdAt: '', updatedAt: '', worktree }) as Session

let stop: () => void = () => {}

beforeEach(() => {
  vi.clearAllMocks()
  resetTerminals()
  useSessionStore.setState({ sessions: [session('a', wt), session('b')] })
  ;(api.listTerminals as Mock).mockResolvedValue(Object.assign([term('t2', '/src/app')], { run: 'r1' }))
  stop = followSessions()
})

afterEach(() => stop())

describe('followSessions', () => {
  it('reloads the shells when a worktree folder goes', async () => {
    useTerminalStore.setState({ terminals: [term('t1', '/wt/app/fix'), term('t2', '/src/app')], loaded: true })
    useSessionStore.setState({ sessions: [session('a', { ...wt, removed: true }), session('b')] })
    await vi.waitFor(() => expect(useTerminalStore.getState().terminals.map((t) => t.id)).toEqual(['t2']))
  })

  it('reloads the shells when a session goes', () => {
    useSessionStore.setState({ sessions: [session('a', wt)] })
    expect(api.listTerminals).toHaveBeenCalledTimes(1)
  })

  it('leaves the shells alone on other changes', () => {
    useSessionStore.setState({ sessions: [session('a', wt), session('b'), session('c')] })
    useSessionStore.setState({ activeId: 'b' })
    expect(api.listTerminals).not.toHaveBeenCalled()
  })

  it('stops following', () => {
    stop()
    useSessionStore.setState({ sessions: [] })
    expect(api.listTerminals).not.toHaveBeenCalled()
  })
})
