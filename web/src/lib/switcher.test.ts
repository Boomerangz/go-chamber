import { describe, expect, it } from 'vitest'
import type { Session } from './api'
import type { Terminal } from './terminal'
import { switcherEntries } from './switcher'

const s = (id: string, extra: Partial<Session> = {}): Session =>
  ({ id, agent: 'claude', cwd: `/p/${id}`, status: 'idle', title: id, createdAt: '2026-01-01T00:00:00Z', ...extra }) as Session
const t = (id: string, extra: Partial<Terminal> = {}): Terminal =>
  ({ id, cwd: `/p/${id}`, shell: 'zsh', title: `term ${id}`, status: 'running', exitCode: 0, createdAt: '2026-01-01T00:00:00Z', ...extra })

describe('switcherEntries', () => {
  it('puts sessions that wait for the owner first, then running, then recent', () => {
    const sessions = [
      s('old', { activeAt: '2026-01-01T00:00:00Z' }),
      s('recent', { activeAt: '2026-01-03T00:00:00Z' }),
      s('busy', { status: 'running', activeAt: '2026-01-02T00:00:00Z' }),
      s('asks', { activeAt: '2026-01-01T00:00:00Z' }),
    ]
    const ids = switcherEntries(sessions, [], new Map([['asks', 1]]), '').map((e) => e.id)
    expect(ids).toEqual(['asks', 'busy', 'recent', 'old'])
  })

  it('lists terminals after sessions and filters both by title or folder', () => {
    const entries = switcherEntries([s('alpha'), s('beta')], [t('t1', { cwd: '/p/alpha-shell' })], new Map(), 'alpha')
    expect(entries.map((e) => [e.kind, e.id])).toEqual([['session', 'alpha'], ['terminal', 't1']])
  })

  it('matches every word of the query in any order', () => {
    const entries = switcherEntries([s('a', { title: 'fix login bug', cwd: '/w/api' })], [], new Map(), 'api login')
    expect(entries).toHaveLength(1)
  })
})
