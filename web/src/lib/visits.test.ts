import { beforeEach, describe, expect, it } from 'vitest'
import type { Session } from './api'
import { endedTurns, isUnseen, markEnded, markVisited, resetVisits, unseenCount, useVisits } from './visits'

const s = (id: string, extra: Partial<Session> = {}): Session => ({ id, agent: 'claude', cwd: '/p', status: 'idle', ...extra })

beforeEach(() => {
  localStorage.clear()
  resetVisits()
})

describe('visits', () => {
  it('marks nothing for a session never opened here', () => {
    expect(isUnseen(s('a', { activeAt: '2026-09-25T10:00:00Z' }), useVisits.getState())).toBe(false)
  })

  it('marks a session whose activity is later than the last visit', () => {
    markVisited(s('a', { activeAt: '2026-09-25T10:00:00Z' }))
    const seen = useVisits.getState()
    expect(isUnseen(s('a', { activeAt: '2026-09-25T10:00:00Z' }), seen)).toBe(false)
    expect(isUnseen(s('a', { activeAt: '2026-09-25T10:05:00Z' }), seen)).toBe(true)
  })

  it('waits for a running turn to end before marking it', () => {
    markVisited(s('a', { activeAt: '2026-09-25T10:00:00Z' }))
    const seen = useVisits.getState()
    expect(isUnseen(s('a', { status: 'running', activeAt: '2026-09-25T10:05:00Z' }), seen)).toBe(false)
  })

  it('survives a reload through storage', () => {
    markVisited(s('a', { activeAt: '2026-09-25T10:00:00Z' }))
    resetVisits()
    expect(useVisits.getState().seen.a).toBe(Date.parse('2026-09-25T10:00:00Z'))
  })

  it('never moves a visit back in time', () => {
    markVisited(s('a', { activeAt: '2026-09-25T10:05:00Z' }))
    markVisited(s('a', { activeAt: '2026-09-25T10:00:00Z' }))
    expect(useVisits.getState().seen.a).toBe(Date.parse('2026-09-25T10:05:00Z'))
  })

  it('counts unseen sessions, leaving out the open one', () => {
    markVisited(s('a', { activeAt: '2026-09-25T10:00:00Z' }))
    markVisited(s('b', { activeAt: '2026-09-25T10:00:00Z' }))
    const later = { activeAt: '2026-09-25T11:00:00Z' }
    expect(unseenCount([s('a', later), s('b', later)], useVisits.getState(), 'b')).toBe(1)
  })

  it('reads only well-formed visits from storage', () => {
    localStorage.setItem('go-chamber:visited:good', '5')
    localStorage.setItem('go-chamber:visited:bad', 'nope')
    localStorage.setItem('go-chamber:visited:zero', '0')
    localStorage.setItem('other:visited:x', '7')
    resetVisits()
    expect(useVisits.getState().seen).toEqual({ good: 5 })
  })

  it('falls back to the creation time, ignoring Go zero times', () => {
    markVisited(s('a', { activeAt: '0001-01-01T00:00:00Z', createdAt: '2026-09-25T09:00:00Z' }))
    expect(useVisits.getState().seen.a).toBe(Date.parse('2026-09-25T09:00:00Z'))
    expect(isUnseen(s('a', { createdAt: '2026-09-25T09:00:00Z' }), useVisits.getState())).toBe(false)
    expect(isUnseen(s('a', { activeAt: 'garbage', createdAt: '2026-09-25T10:00:00Z' }), useVisits.getState())).toBe(true)
  })

  it('uses the clock for a session with no times yet', () => {
    markVisited(s('a'))
    expect(useVisits.getState().seen.a).toBeGreaterThan(Date.parse('2026-01-01T00:00:00Z'))
  })

  it('marks a turn that ended after the last look, until looked at again', () => {
    const a = s('a', { activeAt: '2026-09-25T10:00:00Z' })
    markVisited(a, 1000)
    markEnded('a', 2000)
    expect(isUnseen(a, useVisits.getState())).toBe(true)
    markVisited(a, 1500)
    expect(useVisits.getState().looked.a).toBe(2001)
    expect(isUnseen(a, useVisits.getState())).toBe(false)
    markVisited(a, 3000)
    expect(useVisits.getState().looked.a).toBe(2001)
    resetVisits()
    expect(useVisits.getState()).toMatchObject({ ended: { a: 2000 }, looked: { a: 2001 } })
  })

  it('marks an ended turn even in a session never opened here', () => {
    markEnded('b', 2000)
    expect(isUnseen(s('b'), useVisits.getState())).toBe(true)
    expect(isUnseen(s('b', { status: 'running' }), useVisits.getState())).toBe(false)
  })

  it('finds turns that ended between two lists', () => {
    const before = [s('a', { status: 'running' }), s('b', { status: 'running' }), s('c')]
    const after = [s('a', { status: 'idle' }), s('b', { status: 'running' }), s('c', { status: 'interrupted' }), s('d')]
    expect(endedTurns(before, after)).toEqual(['a'])
  })

  it('keeps working when storage throws', () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked')
      },
    })
    try {
      resetVisits()
      markVisited(s('a', { activeAt: '2026-09-25T10:00:00Z' }))
      expect(useVisits.getState().seen.a).toBeGreaterThan(0)
    } finally {
      Object.defineProperty(globalThis, 'localStorage', real)
    }
  })
})
