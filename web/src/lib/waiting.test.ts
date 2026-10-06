import { describe, expect, it } from 'vitest'
import type { Session, SessionRequest } from './api'
import { waitingCount } from './waiting'

const session = (id: string, over: Partial<Session> = {}): Session =>
  ({ id, agent: 'claude', cwd: '/w', status: 'idle', ...over }) as Session
const request = (sessionId: string, id: string) => ({ sessionId, id, kind: 'question' }) as SessionRequest

describe('waitingCount', () => {
  it('counts what the Requests tray lists: open requests and turns cut off while asking', () => {
    const sessions = [
      session('a', { status: 'interrupted', interruption: { withRequest: true } }),
      session('b', { status: 'interrupted', interruption: { reason: 'quota' } }),
      session('c', { status: 'running' }),
    ]
    expect(waitingCount([request('c', '1'), request('c', '2')], sessions)).toBe(3)
    expect(waitingCount([], sessions)).toBe(1)
    expect(waitingCount([], [])).toBe(0)
  })
})
