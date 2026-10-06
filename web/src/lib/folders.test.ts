import { describe, expect, it } from 'vitest'
import { crumbs, filterFolders, isPathInput, recentFolders } from './folders'
import type { Session } from './api'

describe('crumbs', () => {
  it('starts at home when inside it', () => {
    expect(crumbs('/Users/me/dev/app', '/Users/me')).toEqual([
      { label: '~', path: '/Users/me' },
      { label: 'dev', path: '/Users/me/dev' },
      { label: 'app', path: '/Users/me/dev/app' },
    ])
    expect(crumbs('/Users/me', '/Users/me')).toEqual([{ label: '~', path: '/Users/me' }])
  })

  it('starts at the root outside home', () => {
    expect(crumbs('/tmp/x', '/Users/me')).toEqual([
      { label: '/', path: '/' },
      { label: 'tmp', path: '/tmp' },
      { label: 'x', path: '/tmp/x' },
    ])
    expect(crumbs('/', '/Users/me')).toEqual([{ label: '/', path: '/' }])
    expect(crumbs('/Users/meow', '/Users/me')[1]).toEqual({ label: 'Users', path: '/Users' })
  })
})

describe('filterFolders', () => {
  const folders = [
    { name: 'go-chamber', path: '/d/go-chamber' },
    { name: 'Notes', path: '/d/Notes' },
    { name: 'agent-go', path: '/d/agent-go' },
  ]
  it('matches case-insensitively and ranks prefix matches first', () => {
    expect(filterFolders(folders, 'GO').map((f) => f.name)).toEqual(['go-chamber', 'agent-go'])
    expect(filterFolders(folders, 'no').map((f) => f.name)).toEqual(['Notes'])
  })
  it('returns everything for an empty or path query', () => {
    expect(filterFolders(folders, '  ')).toBe(folders)
    expect(filterFolders(folders, '/tmp')).toBe(folders)
  })
})

describe('isPathInput', () => {
  it('recognizes absolute and home paths', () => {
    expect(isPathInput('/tmp')).toBe(true)
    expect(isPathInput('~/dev')).toBe(true)
    expect(isPathInput('~')).toBe(true)
    expect(isPathInput('dev')).toBe(false)
  })
})

describe('recentFolders', () => {
  const s = (cwd: string, parentId?: string): Session => ({ id: cwd, agent: 'claude', cwd, status: 'idle', parentId })
  it('lists unique session folders, newest first, skipping children', () => {
    expect(recentFolders([s('/a'), s('/b'), s('/a'), s('/c', 'x'), s('/d')], 3)).toEqual(['/d', '/a', '/b'])
  })

  it('offers a worktree session’s repository, not the worktree', () => {
    const w: Session = { ...s('/data/worktrees/app/x'), worktree: { repo: '/p/app', path: '/data/worktrees/app/x', branch: 'chamber/x', base: 'main' } }
    expect(recentFolders([s('/p/app'), w], 3)).toEqual(['/p/app'])
  })

  it('never offers a removed worktree’s folder, even through a fork made in it', () => {
    const gone: Session = { ...s('/data/worktrees/app/x'), worktree: { repo: '/p/app', path: '/data/worktrees/app/x', branch: 'chamber/x', base: 'main', removed: true } }
    const fork: Session = { ...s('/data/worktrees/app/x'), id: 'fork' }
    expect(recentFolders([s('/p/other'), gone, fork], 3)).toEqual(['/p/app', '/p/other'])
  })
})
