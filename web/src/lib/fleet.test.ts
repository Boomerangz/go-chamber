import { describe, expect, it } from 'vitest'
import type { Session, SessionRequest } from './api'
import { fleet, fleetText } from './fleet'

const s = (id: string, status: Session['status'], extra: Partial<Session> = {}) => ({ id, status, ...extra }) as Session
const r = (sessionId: string) => ({ id: `r-${sessionId}`, sessionId }) as SessionRequest

describe('fleet', () => {
  it('counts top-level running sessions, a held one as waiting only', () => {
    const sessions = [s('a', 'running'), s('b', 'running'), s('c', 'idle'), s('d', 'running', { parentId: 'a' })]
    expect(fleet(sessions, [r('b')], 1)).toEqual({ running: 1, waiting: 1 })
  })

  it('takes the waiting count as given (requests and owed answers)', () => {
    expect(fleet([], [], 3)).toEqual({ running: 0, waiting: 3 })
  })
})

describe('fleetText', () => {
  it('says only what is non-zero, running first', () => {
    expect(fleetText({ running: 2, waiting: 1 })).toBe('2 running · 1 waiting')
    expect(fleetText({ running: 0, waiting: 1 })).toBe('1 waiting')
    expect(fleetText({ running: 3, waiting: 0 })).toBe('3 running')
  })

  it('is empty when nothing runs or waits', () => {
    expect(fleetText({ running: 0, waiting: 0 })).toBe('')
  })
})
