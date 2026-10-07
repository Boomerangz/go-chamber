import { describe, expect, it } from 'vitest'
import { pathBreaks, pathParts, relativePath, shortPath } from './path'

describe('shortPath', () => {
  it('writes the home folder as ~', () => {
    expect(shortPath('/Users/me/Develop/app', '/Users/me')).toBe('~/Develop/app')
    expect(shortPath('/Users/me', '/Users/me')).toBe('~')
    expect(shortPath('/Users/me/', '/Users/me/')).toBe('~')
  })

  it('leaves a path outside home, or a look-alike, as it is', () => {
    expect(shortPath('/Users/meg/app', '/Users/me')).toBe('/Users/meg/app')
    expect(shortPath('/tmp/x', '/Users/me')).toBe('/tmp/x')
    expect(shortPath('/tmp/x', undefined)).toBe('/tmp/x')
    expect(shortPath('/tmp/x', '')).toBe('/tmp/x')
    expect(shortPath('/tmp/x', '/')).toBe('/tmp/x')
  })

  it('drops a trailing slash so the last name is the folder', () => {
    expect(shortPath('/tmp/x/', undefined)).toBe('/tmp/x')
    expect(shortPath('/', undefined)).toBe('/')
  })

  it('cuts a long path from the start, keeping the last folder whole', () => {
    expect(shortPath('/a/bbbb/cccc/project', undefined, 14)).toBe('…/cccc/project')
    expect(shortPath('/a/bbbb/cccc/project', undefined, 20)).toBe('/a/bbbb/cccc/project')
    expect(shortPath('/Users/me/Develop/app', '/Users/me', 8)).toBe('…/app')
  })

  it('keeps the last folder even when it alone is longer than the limit', () => {
    expect(shortPath('/a/an-extraordinarily-long-name', undefined, 10)).toBe('…/an-extraordinarily-long-name')
  })
})

describe('pathParts', () => {
  it('splits into the folders above and the last one, home as ~', () => {
    expect(pathParts('/Users/me/Develop/app', '/Users/me')).toEqual({ head: '~/Develop/', tail: 'app' })
    expect(pathParts('/tmp/x/', undefined)).toEqual({ head: '/tmp/', tail: 'x' })
    expect(pathParts('/Users/me', '/Users/me')).toEqual({ head: '', tail: '~' })
    expect(pathParts('/', undefined)).toEqual({ head: '', tail: '/' })
    expect(pathParts('relative', undefined)).toEqual({ head: '', tail: 'relative' })
  })
})

describe('relativePath', () => {
  it('writes a path inside the session folder from that folder', () => {
    expect(relativePath('/w/proj/src/a.go', '/w/proj')).toBe('src/a.go')
    expect(relativePath('/w/proj/src/a.go', '/w/proj/')).toBe('src/a.go')
    expect(relativePath('/w/proj', '/w/proj')).toBe('.')
  })

  it('keeps a path outside the folder, a sibling with the same prefix, or no folder', () => {
    expect(relativePath('/w/project2/a.go', '/w/proj')).toBe('/w/project2/a.go')
    expect(relativePath('/etc/hosts', '/w/proj')).toBe('/etc/hosts')
    expect(relativePath('src/a.go', '/w/proj')).toBe('src/a.go')
    expect(relativePath('/w/proj/a.go', undefined)).toBe('/w/proj/a.go')
    expect(relativePath('/a.go', '/')).toBe('/a.go')
  })
})

describe('pathBreaks', () => {
  it('cuts a long path in text after each slash, where a line may break', () => {
    expect(pathBreaks('see internal/adapters/http/worktrees.go now')).toEqual(['see internal/', 'adapters/', 'http/', 'worktrees.go now'])
  })

  it('leaves numbers, short paths and plain words whole', () => {
    expect(pathBreaks('1290/1300 lines')).toEqual(['1290/1300 lines'])
    expect(pathBreaks('either a/b or c')).toEqual(['either a/b or c'])
    expect(pathBreaks('a long sentence of words')).toEqual(['a long sentence of words'])
    expect(pathBreaks('2026/10/07/12/30/45')).toEqual(['2026/10/07/12/30/45'])
  })

  it('keeps a trailing slash with its folder', () => {
    expect(pathBreaks('web/src/components/')).toEqual(['web/', 'src/', 'components/'])
  })
})
