import { describe, expect, it } from 'vitest'
import { pathParts, shortPath } from './path'

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
