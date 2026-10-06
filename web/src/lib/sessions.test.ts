import { describe, expect, it } from 'vitest'
import type { Session } from './api'
import { archivedSessions, bucketOf, groupSessions, matchesQuery, relativeTime, sessionTitle, snippetParts, visibleInGroup } from './sessions'

const now = new Date('2026-09-25T12:00:00Z')
const s = (id: string, cwd: string, activeAt: string, over: Partial<Session> = {}): Session => ({
  id, agent: 'claude', cwd, status: 'idle', activeAt, createdAt: activeAt, ...over,
})

describe('groupSessions', () => {
  const sessions = [
    s('a1', '/p/alpha', '2026-09-20T10:00:00Z'),
    s('b1', '/p/beta', '2026-09-25T11:00:00Z', { status: 'running' }),
    s('a2', '/p/alpha', '2026-09-24T10:00:00Z'),
    s('child', '/p/alpha', '2026-09-24T10:30:00Z', { parentId: 'a2' }),
    s('old', '/p/gamma', ''),
  ]
  const groups = groupSessions(sessions)

  it('groups top-level sessions by folder, most recent group first', () => {
    expect(groups.map((g) => g.cwd)).toEqual(['/p/beta', '/p/alpha', '/p/gamma'])
    expect(groups[1].name).toBe('alpha')
  })

  it('orders sessions newest first and nests children under parents', () => {
    const alpha = groups[1]
    expect(alpha.nodes.map((n) => n.session.id)).toEqual(['a2', 'a1'])
    expect(alpha.nodes[0].children.map((n) => n.session.id)).toEqual(['child'])
    expect(alpha.count).toBe(2)
  })

  it('flags running groups', () => {
    expect(groups[0].running).toBe(true)
    expect(groups[1].running).toBe(false)
  })

  it('counts a running child as a running group', () => {
    const g = groupSessions([s('p', '/x', '2026-09-24T10:00:00Z'), s('c', '/x', '', { parentId: 'p', status: 'running' })])
    expect(g[0].running).toBe(true)
  })
})

describe('group names', () => {
  it('adds the parent folder when two groups share a folder name', () => {
    const groups = groupSessions([
      s('a', '/src/app/web', '2026-09-24T10:00:00Z'),
      s('b', '/src/site/web', '2026-09-23T10:00:00Z'),
      s('c', '/src/api', '2026-09-22T10:00:00Z'),
    ])
    expect(groups.map((g) => g.name)).toEqual(['app/web', 'site/web', 'api'])
  })

  it('keeps a plain name for a root-level folder that collides', () => {
    const groups = groupSessions([s('a', '/web', '2026-09-24T10:00:00Z'), s('b', '/x/web', '2026-09-23T10:00:00Z')])
    expect(groups.map((g) => g.name)).toEqual(['web', 'x/web'])
  })
})

describe('visibleInGroup', () => {
  const group = groupSessions(
    Array.from({ length: 8 }, (_, i) => s(`s${i}`, '/p', `2026-09-2${i}T00:00:00Z`)),
  )[0]

  it('hides everything when collapsed except the open session', () => {
    expect(visibleInGroup(group, 'collapsed', 5, null)).toEqual({ shown: [], hidden: 8 })
    expect(visibleInGroup(group, 'collapsed', 5, 's0').shown.map((n) => n.session.id)).toEqual(['s0'])
  })

  it('shows the recent N and keeps the open session visible', () => {
    const recent = visibleInGroup(group, 'recent', 5, null)
    expect(recent.shown.map((n) => n.session.id)).toEqual(['s7', 's6', 's5', 's4', 's3'])
    expect(recent.hidden).toBe(3)
    const withOld = visibleInGroup(group, 'recent', 5, 's0')
    expect(withOld.shown.map((n) => n.session.id)).toEqual(['s7', 's6', 's5', 's4', 's3', 's0'])
    expect(withOld.hidden).toBe(2)
  })

  it('shows everything in all mode', () => {
    expect(visibleInGroup(group, 'all', 5, null)).toMatchObject({ hidden: 0 })
    expect(visibleInGroup(group, 'all', 5, null).shown).toHaveLength(8)
  })

  it('finds an open child session inside a hidden parent', () => {
    const g = groupSessions([
      s('new', '/p', '2026-09-25T00:00:00Z'),
      s('old', '/p', '2026-09-01T00:00:00Z'),
      s('kid', '/p', '', { parentId: 'old' }),
    ])[0]
    expect(visibleInGroup(g, 'recent', 1, 'kid').shown.map((n) => n.session.id)).toEqual(['new', 'old'])
  })
})

describe('bucketOf', () => {
  it('names time buckets relative to now', () => {
    expect(bucketOf('2026-09-25T01:00:00Z', now)).toBe('Today')
    expect(bucketOf('2026-09-24T12:00:00Z', now)).toBe('Yesterday')
    expect(bucketOf('2026-09-20T12:00:00Z', now)).toBe('This week')
    expect(bucketOf('2026-09-01T12:00:00Z', now)).toBe('This month')
    expect(bucketOf('2026-06-01T12:00:00Z', now)).toBe('Older')
    expect(bucketOf(undefined, now)).toBe('Older')
  })
})

describe('relativeTime', () => {
  it('formats short relative times', () => {
    expect(relativeTime('2026-09-25T11:59:40Z', now)).toBe('just now')
    expect(relativeTime('2026-09-25T11:15:00Z', now)).toBe('45m ago')
    expect(relativeTime('2026-09-25T09:00:00Z', now)).toBe('3h ago')
    expect(relativeTime('2026-09-22T12:00:00Z', now)).toBe('3d ago')
    expect(relativeTime('2026-06-01T12:00:00Z', now)).toMatch(/2026|Jun/)
    expect(relativeTime(undefined, now)).toBe('')
    expect(relativeTime('0001-01-01T00:00:00Z', now)).toBe('')
  })
})

describe('matchesQuery', () => {
  const session = s('x', '/Users/me/go-chamber', '', { title: 'Fix picker' })
  it('matches title and path case-insensitively', () => {
    expect(matchesQuery(session, 'PICKER')).toBe(true)
    expect(matchesQuery(session, 'chamber')).toBe(true)
    expect(matchesQuery(session, 'codex')).toBe(false)
    expect(matchesQuery(session, '  ')).toBe(true)
  })
  it('matches the agent name', () => {
    expect(matchesQuery(session, 'claude')).toBe(true)
  })
})

describe('sessionTitle', () => {
  it('uses the title or names the agent', () => {
    expect(sessionTitle(s('x', '/p', '', { title: 'Fix it' }))).toBe('Fix it')
    expect(sessionTitle(s('x', '/p', ''))).toBe('New Claude session')
    expect(sessionTitle(s('x', '/p', '', { agent: 'codex' }))).toBe('New Codex session')
  })
})

describe('snippetParts', () => {
  it('splits matches from plain text', () => {
    expect(snippetParts('…the [[picker]] uses a [[portal]].')).toEqual([
      { text: '…the ', match: false },
      { text: 'picker', match: true },
      { text: ' uses a ', match: false },
      { text: 'portal', match: true },
      { text: '.', match: false },
    ])
    expect(snippetParts('[[a]]')).toEqual([{ text: 'a', match: true }])
    expect(snippetParts('plain')).toEqual([{ text: 'plain', match: false }])
    expect(snippetParts('')).toEqual([])
  })
})

describe('archived sessions', () => {
  const sessions = [
    s('kept', '/p/alpha', '2026-09-24T10:00:00Z'),
    s('away', '/p/alpha', '2026-09-23T10:00:00Z', { archivedAt: '2026-09-25T08:00:00Z' }),
    s('sub', '/p/alpha', '2026-09-23T10:30:00Z', { parentId: 'away' }),
    s('subsub', '/p/alpha', '2026-09-23T10:40:00Z', { parentId: 'sub' }),
    s('later', '/p/beta', '2026-09-20T10:00:00Z', { archivedAt: '2026-09-25T09:00:00Z' }),
    s('alone', '/p/gamma', '2026-09-20T10:00:00Z', { archivedAt: '2026-09-24T09:00:00Z' }),
  ]

  it('leaves archived sessions and their subagents out of the groups', () => {
    const groups = groupSessions(sessions)
    expect(groups.map((g) => g.cwd)).toEqual(['/p/alpha'])
    expect(groups[0].nodes.map((n) => n.session.id)).toEqual(['kept'])
    expect(groups[0].count).toBe(1)
  })

  it('lists archived sessions newest archived first, with their subagents', () => {
    const nodes = archivedSessions(sessions)
    expect(nodes.map((n) => n.session.id)).toEqual(['later', 'away', 'alone'])
    expect(nodes[1].children.map((n) => n.session.id)).toEqual(['sub'])
    expect(nodes[1].children[0].children.map((n) => n.session.id)).toEqual(['subsub'])
  })

  it('has nothing archived when nothing is', () => {
    expect(archivedSessions([s('a', '/p', '')])).toEqual([])
  })
})
