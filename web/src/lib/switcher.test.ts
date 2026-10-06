import { describe, expect, it } from 'vitest'
import type { Session } from './api'
import type { Terminal } from './terminal'
import { fuzzyMatch, switcherEntries } from './switcher'

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
    const ids = switcherEntries(sessions, [], new Map([['asks', 1]]), '').filter((e) => e.kind === 'session').map((e) => e.id)
    expect(ids).toEqual(['asks', 'busy', 'recent', 'old'])
  })

  it('lists terminals after sessions and filters both by title or folder', () => {
    const entries = switcherEntries([s('alpha'), s('beta')], [t('t1', { cwd: '/p/alpha-shell' })], new Map(), 'alpha')
    const found = entries.filter((e) => e.kind !== 'new')
    expect(found.map((e) => [e.kind, e.id])).toEqual([['session', 'alpha'], ['terminal', 't1']])
  })

  it('matches every word of the query in any order', () => {
    const entries = switcherEntries([s('a', { title: 'fix login bug', cwd: '/w/api' })], [], new Map(), 'api login')
    expect(entries).toHaveLength(1)
  })

  it('matches letters in order, not only whole words, and marks them', () => {
    const [entry] = switcherEntries([s('a', { title: 'fix login bug' })], [], new Map(), 'flb')
    expect(entry!.id).toBe('a')
    expect(entry!.titleHits).toEqual([0, 4, 10])
  })

  it('ranks a closer match first when there is a query', () => {
    const sessions = [s('loose', { title: 'l-o-g-i-n' }), s('tight', { title: 'login page' })]
    const ids = switcherEntries(sessions, [], new Map(), 'login').map((e) => e.id)
    expect(ids.slice(0, 2)).toEqual(['tight', 'loose'])
  })

  it('names folders apart when two share a last part', () => {
    const entries = switcherEntries([s('a', { cwd: '/x/web' }), s('b', { cwd: '/y/web' })], [], new Map(), '')
    expect(entries.filter((e) => e.kind === 'session').map((e) => e.detail).sort()).toEqual(['x/web', 'y/web'])
  })

  it('tags the open session and carries its time', () => {
    const entries = switcherEntries([s('a', { activeAt: '2026-01-02T00:00:00Z' })], [], new Map(), '', { activeId: 'a' })
    expect(entries[0]).toMatchObject({ current: true, at: '2026-01-02T00:00:00Z' })
  })

  it('offers new sessions in the open folder, and in any folder that matches', () => {
    const sessions = [s('a', { cwd: '/w/api' }), s('b', { cwd: '/w/site' })]
    const idle = switcherEntries(sessions, [], new Map(), '', { activeId: 'a' }).filter((e) => e.kind === 'new')
    expect(idle.map((e) => e.title)).toEqual(['New Claude session in api', 'New Codex session in api'])
    const typed = switcherEntries(sessions, [], new Map(), 'new codex site').filter((e) => e.kind === 'new')
    expect(typed.map((e) => [e.title, e.cwd, e.agent])).toEqual([['New Codex session in site', '/w/site', 'codex']])
  })
})

describe('fuzzyMatch', () => {
  it('prefers a run of letters to scattered ones', () => {
    expect(fuzzyMatch('login', 'log')!.score).toBeGreaterThan(fuzzyMatch('l-o-g', 'log')!.score)
    expect(fuzzyMatch('abc', 'abd')).toBeNull()
  })

  it('scores a run by where it starts', () => {
    expect(fuzzyMatch('Login', 'log')).toEqual({ score: 120, hits: [0, 1, 2] })
    expect(fuzzyMatch('my login', 'LOG')).toEqual({ score: 117, hits: [3, 4, 5] })
    expect(fuzzyMatch('xlogin', 'log')).toEqual({ score: 99, hits: [1, 2, 3] })
    expect(fuzzyMatch('x'.repeat(30) + 'log', 'log')!.score).toBe(80)
    expect(fuzzyMatch('anything', '')).toEqual({ score: 0, hits: [] })
  })

  it('scores scattered letters by runs and word starts', () => {
    expect(fuzzyMatch('fix login bug', 'flb')).toEqual({ score: 12, hits: [0, 4, 10] })
    expect(fuzzyMatch('abxc', 'abc')).toEqual({ score: 11, hits: [0, 1, 3] })
    expect(fuzzyMatch('aba', 'aa')).toEqual({ score: 5, hits: [0, 2] })
    expect(fuzzyMatch('ba-c', 'bc')).toEqual({ score: 8, hits: [0, 3] })
  })
})

describe('switcher matching', () => {
  it('finds a session by its agent or full path without marking letters', () => {
    const entries = switcherEntries([s('a', { title: 'x', agent: 'codex', cwd: '/deep/p' })], [], new Map(), 'deep')
    const session = entries.find((e) => e.kind === 'session')!
    expect(session.titleHits).toEqual([])
    expect(session.detailHits).toEqual([])
  })

  it('marks the folder when the title does not match', () => {
    const [entry] = switcherEntries([s('a', { title: 'zzz', cwd: '/w/api' })], [], new Map(), 'api')
    expect(entry).toMatchObject({ kind: 'session', titleHits: [], detailHits: [0, 1, 2] })
  })

  it('prefers the title when both match about as well', () => {
    const [entry] = switcherEntries([s('a', { title: 'api work', cwd: '/w/api' })], [], new Map(), 'api')
    expect(entry).toMatchObject({ titleHits: [0, 1, 2], detailHits: [] })
  })

  it('offers new sessions in the most recent folder when none is open', () => {
    const sessions = [s('a', { cwd: '/w/old', activeAt: '2026-01-01T00:00:00Z' }), s('b', { cwd: '/w/new', activeAt: '2026-01-05T00:00:00Z' }), s('c', { cwd: '/w/kid', parentId: 'b', activeAt: '2026-01-09T00:00:00Z' })]
    const fresh = switcherEntries(sessions, [], new Map(), '').filter((e) => e.kind === 'new')
    expect(fresh.map((e) => e.cwd)).toEqual(['/w/new', '/w/new'])
  })

  it('orders new-session folders by recency when asked', () => {
    const sessions = [s('a', { cwd: '/w/old', activeAt: '2026-01-01T00:00:00Z' }), s('b', { cwd: '/w/new', activeAt: '2026-01-05T00:00:00Z' })]
    const fresh = switcherEntries(sessions, [], new Map(), 'claude').filter((e) => e.kind === 'new')
    expect(fresh.map((e) => e.cwd)).toEqual(['/w/new', '/w/old'])
  })
})
