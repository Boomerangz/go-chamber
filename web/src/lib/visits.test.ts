import { beforeEach, describe, expect, it } from 'vitest'
import type { Session } from './api'
import { isUnseen, markVisited, resetVisits, unseenCount, useVisits } from './visits'

const s = (id: string, extra: Partial<Session> = {}): Session => ({ id, agent: 'claude', cwd: '/p', status: 'idle', ...extra })

beforeEach(() => {
  localStorage.clear()
  resetVisits()
})

describe('visits', () => {
  it('marks nothing for a session never opened here', () => {
    expect(isUnseen(s('a', { activeAt: '2026-09-25T10:00:00Z' }), useVisits.getState().seen)).toBe(false)
  })

  it('marks a session whose activity is later than the last visit', () => {
    markVisited(s('a', { activeAt: '2026-09-25T10:00:00Z' }))
    const seen = useVisits.getState().seen
    expect(isUnseen(s('a', { activeAt: '2026-09-25T10:00:00Z' }), seen)).toBe(false)
    expect(isUnseen(s('a', { activeAt: '2026-09-25T10:05:00Z' }), seen)).toBe(true)
  })

  it('waits for a running turn to end before marking it', () => {
    markVisited(s('a', { activeAt: '2026-09-25T10:00:00Z' }))
    const seen = useVisits.getState().seen
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
    expect(unseenCount([s('a', later), s('b', later)], useVisits.getState().seen, 'b')).toBe(1)
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
