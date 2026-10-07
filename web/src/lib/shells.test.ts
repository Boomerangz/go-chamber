import { describe, expect, it } from 'vitest'
import type { Session } from './api'
import type { Terminal } from './terminal'
import { closingNote, shellsMayHaveGone, shellsWithin, within } from './shells'

const term = (id: string, cwd: string): Terminal => ({ id, cwd, shell: '/bin/zsh', title: id, status: 'running', exitCode: 0, createdAt: '' })

const session = (id: string, worktree?: Session['worktree']): Session =>
  ({ id, agent: 'claude', cwd: worktree?.path ?? '/src/app', status: 'idle', createdAt: '', updatedAt: '', worktree }) as Session

describe('within', () => {
  it('takes the folder and folders below it', () => {
    expect(within('/wt/app/fix', '/wt/app/fix')).toBe(true)
    expect(within('/wt/app/fix/web', '/wt/app/fix')).toBe(true)
    expect(within('/wt/app/fix/', '/wt/app/fix')).toBe(true)
    expect(within('/wt/app/fix', '/wt/app/fix/')).toBe(true)
  })
  it('leaves a folder that only shares the prefix, or one above', () => {
    expect(within('/wt/app/fix-2', '/wt/app/fix')).toBe(false)
    expect(within('/wt/app', '/wt/app/fix')).toBe(false)
    expect(within('/wt/app/fix', '')).toBe(false)
    expect(within('/wt/app/fix', '/')).toBe(true)
  })
})

describe('shellsWithin', () => {
  it('counts the shells in the folder', () => {
    const terms = [term('a', '/wt/app/fix'), term('b', '/wt/app/fix/web'), term('c', '/wt/app/fix-2')]
    expect(shellsWithin(terms, '/wt/app/fix')).toBe(2)
    expect(shellsWithin(terms, '/elsewhere')).toBe(0)
    expect(shellsWithin(terms, undefined)).toBe(0)
  })
})

describe('closingNote', () => {
  it('says how many shells close', () => {
    expect(closingNote(0)).toBeNull()
    expect(closingNote(1)).toBe('1 terminal in it will close.')
    expect(closingNote(3)).toBe('3 terminals in it will close.')
  })
})

describe('shellsMayHaveGone', () => {
  const wt = { repo: '/src/app', path: '/wt/app/fix', branch: 'chamber/fix', base: 'b' }
  it('is set when a session goes', () => {
    expect(shellsMayHaveGone([session('a'), session('b')], [session('a')])).toBe(true)
  })
  it('is set when a worktree folder goes', () => {
    expect(shellsMayHaveGone([session('a', wt)], [session('a', { ...wt, removed: true })])).toBe(true)
  })
  it('is not set for other changes', () => {
    const removed = { ...wt, removed: true }
    expect(shellsMayHaveGone([session('a')], [session('a'), session('b')])).toBe(false)
    expect(shellsMayHaveGone([session('a', removed)], [session('a', removed)])).toBe(false)
    expect(shellsMayHaveGone([session('a', wt)], [session('a', wt)])).toBe(false)
    expect(shellsMayHaveGone([], [])).toBe(false)
    const same = [session('a', wt)]
    expect(shellsMayHaveGone(same, same)).toBe(false)
  })
})
