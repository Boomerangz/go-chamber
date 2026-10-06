import { describe, expect, it } from 'vitest'
import { parseRoute, routePath } from './route'

describe('route', () => {
  it.each(['/s/%', '/t/%E0%A4', '/s/%GG'])('ignores malformed encoded route %s', (path) => {
    expect(parseRoute(path)).toEqual({ kind: 'none' })
  })

  it('parses session and terminal paths', () => {
    expect(parseRoute('/s/abc')).toEqual({ kind: 'session', id: 'abc' })
    expect(parseRoute('/t/t%201/')).toEqual({ kind: 'terminal', id: 't 1' })
    expect(parseRoute('/diagnostics')).toEqual({ kind: 'diagnostics' })
    expect(parseRoute('/terminal')).toEqual({ kind: 'terminals' })
    expect(parseRoute('/terminal/')).toEqual({ kind: 'terminals' })
    expect(parseRoute('/')).toEqual({ kind: 'none' })
    expect(parseRoute('/s/a/b')).toEqual({ kind: 'none' })
    expect(parseRoute('/sessions/x')).toEqual({ kind: 'none' })
  })

  it('builds the path for what is open', () => {
    expect(routePath('diagnostics', 'abc', 't1')).toBe('/diagnostics')
    expect(routePath('agents', 'abc', 't1')).toBe('/s/abc')
    expect(routePath('terminal', 'abc', 't 1')).toBe('/t/t%201')
    expect(routePath('agents', null, 't1')).toBe('/')
    // terminal mode with no shell attached is a step of its own
    expect(routePath('terminal', 'abc', null)).toBe('/terminal')
  })

  it('round-trips ids', () => {
    for (const id of ['abc', 'a b', 'ü/?#']) {
      expect(parseRoute(routePath('agents', id, null))).toEqual({ kind: 'session', id })
    }
  })
})
