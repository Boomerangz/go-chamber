import { describe, expect, it } from 'vitest'
import { markOf, sortForSession } from './marks'
import type { Terminal } from '../../lib/terminal'

const term = (over: Partial<Terminal> = {}): Terminal => ({
  id: 't1', cwd: '/h', shell: 'sh', title: 'h', status: 'running', exitCode: 0, createdAt: '', ...over,
})

describe('markOf', () => {
  it('draws a running shell solid', () => {
    expect(markOf(term())).toEqual({ form: 'running', label: 'running' })
    expect(markOf(term(), { state: 'live' })).toEqual({ form: 'running', label: 'running' })
  })

  it('draws a connection being made dashed', () => {
    expect(markOf(term(), { state: 'connecting' })).toEqual({ form: 'pending', label: 'connecting' })
    expect(markOf(term(), { state: 'reconnecting', attempt: 2 })).toEqual({ form: 'pending', label: 'reconnecting' })
  })

  it('strikes a lost connection and an exited shell', () => {
    expect(markOf(term(), { state: 'disconnected' })).toEqual({ form: 'struck', label: 'disconnected' })
    expect(markOf(term({ status: 'exited', exitCode: 3 }), { state: 'live' })).toEqual({ form: 'struck', label: 'exited 3' })
  })
})

describe('sortForSession', () => {
  it("puts the session's terminals first and keeps the rest in order", () => {
    const list = [term({ id: 'a' }), term({ id: 'b', sessionId: 's1' }), term({ id: 'c' }), term({ id: 'd', sessionId: 's1' })]
    expect(sortForSession(list, 's1').map((t) => t.id)).toEqual(['b', 'd', 'a', 'c'])
    expect(sortForSession(list, null).map((t) => t.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})
