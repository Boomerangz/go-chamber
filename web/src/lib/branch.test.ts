import { describe, expect, it } from 'vitest'
import { branchError, branchPreview, continuable, folderError, slugify } from './branch'

describe('slugify', () => {
  // The same cases as the server's TestSlugify: the preview must say what
  // the server will make of the name.
  it.each([
    ['Fix login bug!', 'fix-login-bug'],
    ['chamber/feature.x', 'feature.x'],
    ['...a..b', 'a.b'],
    ['  ', ''],
    ['Привет world', 'world'],
    ['a_b-c', 'a_b-c'],
    ['fix/ws', 'fix-ws'],
    ['x0123456789012345678901234567890123456789012345678901234', 'x0123456789012345678901234567890123456789012345678'],
  ])('%s → %s', (name, slug) => {
    expect(slugify(name)).toBe(slug)
  })
})

describe('branchPreview', () => {
  it('says nothing until a name is typed', () => {
    expect(branchPreview('')).toEqual({})
    expect(branchPreview('   ')).toEqual({})
  })

  it('names the branch that will be made', () => {
    expect(branchPreview('fix/ws')).toEqual({ branch: 'chamber/fix-ws' })
    expect(branchPreview('fix-ws')).toEqual({ branch: 'chamber/fix-ws' })
  })

  it('says when letters are dropped', () => {
    expect(branchPreview('Фича test')).toEqual({ branch: 'chamber/test', note: 'only latin letters, digits, . and _ are kept' })
  })

  it('refuses a name with nothing a branch can be made of', () => {
    expect(branchPreview('Фича тест')).toEqual({ error: 'Use latin letters or digits' })
  })

  it('says when the name is cut', () => {
    const long = 'a'.repeat(60)
    expect(branchPreview(long)).toEqual({ branch: `chamber/${'a'.repeat(50)}`, note: 'cut to 50 characters' })
  })
})

describe('branchError', () => {
  it('reads the server refusals in the form’s words', () => {
    expect(branchError('branch already exists: chamber/fix')).toBe('Branch chamber/fix already exists')
    expect(branchError('worktree folder already exists: /w/app/fix')).toBe('Its worktree folder /w/app/fix already exists')
    expect(branchError('invalid branch name: use latin letters or digits')).toBe('Use latin letters or digits')
    expect(branchError('branch chamber/fix is checked out at /w/app/fix')).toBe('Branch chamber/fix is checked out in /w/app/fix')
    expect(branchError('no such branch: chamber/fix')).toBe('Branch chamber/fix is no longer there')
  })

  it('tells a branch that can be continued on', () => {
    expect(continuable('branch already exists: chamber/fix')).toBe(true)
    expect(continuable('branch chamber/fix is checked out at /w/app/fix')).toBe(false)
    expect(continuable('database is locked')).toBe(false)
    expect(continuable(null)).toBe(false)
  })

  it('leaves what is not about the branch to others', () => {
    expect(branchError('not a git repository')).toBeNull()
    expect(branchError('git rev-parse: : chdir /nonexistent/x: no such file or directory')).toBeNull()
    expect(branchError('database is locked')).toBeNull()
  })
})

describe('folderError', () => {
  it('reads a refused folder in the form’s words', () => {
    expect(folderError("Folder /nope doesn't exist")).toBe("Folder /nope doesn't exist")
    expect(folderError('Folder /gone no longer exists')).toBe('Folder /gone no longer exists')
    expect(folderError('not a git repository')).toBe('Not a git repository')
    expect(folderError('database is locked')).toBeNull()
    expect(folderError('branch already exists: chamber/fix')).toBeNull()
  })
})
