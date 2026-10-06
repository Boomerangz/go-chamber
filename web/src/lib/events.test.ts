import { describe, expect, it } from 'vitest'
import { applyEvent, applyEvents, initialChat, TURN_FAILED } from './events'
import type { Item, SessionEvent, SessionRequest, TurnResult } from './api'

const item = (over: Partial<Item> = {}): Item => ({
  id: 'i1',
  sessionId: 's1',
  kind: 'assistant_message',
  status: 'streaming',
  ...over,
})

const ev = (over: Partial<SessionEvent>): SessionEvent => ({
  seq: 1,
  sessionId: 's1',
  type: 'item.updated',
  ...over,
})

describe('applyEvent', () => {
  it('adds new items in order', () => {
    let state = initialChat()
    state = applyEvent(state, ev({ seq: 1, item: item({ id: 'a' }) }))
    state = applyEvent(state, ev({ seq: 2, item: item({ id: 'b' }) }))
    expect(state.order).toEqual(['a', 'b'])
    expect(state.lastSeq).toBe(2)
  })

  it('updates an existing item without duplicating order', () => {
    let state = initialChat()
    state = applyEvent(state, ev({ seq: 1, item: item({ id: 'a', text: 'partial' }) }))
    state = applyEvent(state, ev({ seq: 2, item: item({ id: 'a', text: 'final', status: 'completed' }) }))
    expect(state.order).toEqual(['a'])
    expect(state.items['a']!.text).toBe('final')
  })

  it('appends streamed text', () => {
    let state = initialChat()
    state = applyEvent(state, ev({ seq: 1, item: item({ id: 'a', text: 'Hel' }) }))
    state = applyEvent(state, ev({ seq: 2, type: 'text.delta', delta: { itemId: 'a', text: 'lo' } }))
    expect(state.items['a']!.text).toBe('Hello')
  })

  it('ignores deltas for unknown items', () => {
    const state = initialChat()
    const next = applyEvent(state, ev({ seq: 1, type: 'text.delta', delta: { itemId: 'missing', text: 'x' } }))
    expect(next).toEqual({ ...state, lastSeq: 1 })
  })

  it('ignores stale events', () => {
    const state = initialChat()
    const withSeq = applyEvent(state, ev({ seq: 5, item: item({ id: 'a' }) }))
    const stale = applyEvent(withSeq, ev({ seq: 3, item: item({ id: 'b' }) }))
    expect(stale).toBe(withSeq)
  })

  it('tracks session status', () => {
    let state = initialChat()
    state = applyEvent(state, ev({ seq: 1, type: 'turn.started' }))
    expect(state.status).toBe('running')
    state = applyEvent(state, ev({ seq: 2, type: 'turn.ended', result: { text: 'done' } }))
    expect(state.status).toBe('idle')
    expect(state.result).toEqual({ text: 'done' })
    state = applyEvent(state, ev({ seq: 3, type: 'session.state', session: {
      id: 's1', agent: 'claude', cwd: '/p', status: 'interrupted',
    } }))
    expect(state.status).toBe('interrupted')
  })

  it('tracks token usage', () => {
    let state = initialChat()
    state = applyEvent(state, ev({ seq: 1, type: 'usage', usage: { totalTokens: 42, costUsd: 0.01 } }))
    expect(state.usage).toEqual({ totalTokens: 42, costUsd: 0.01 })
    state = applyEvent(state, ev({ seq: 2, type: 'usage' }))
    expect(state.usage).toEqual({ totalTokens: 42, costUsd: 0.01 })
  })

  it('tolerates payload-less events', () => {
    let state = initialChat()
    state = applyEvent(state, ev({ seq: 1, type: 'item.updated', item: undefined }))
    expect(state.order).toEqual([])
    state = applyEvent(state, ev({ seq: 2, type: 'text.delta' }))
    expect(state.order).toEqual([])
  })
})

describe('request events', () => {
  const request = (id: string): SessionRequest => ({
    id, sessionId: 's1', kind: 'permission', state: 'pending', title: 'Run',
  })

  it('adds and removes requests', () => {
    let state = initialChat()
    state = applyEvent(state, ev({ seq: 1, type: 'request.opened', request: request('r1') }))
    expect(Object.keys(state.requests)).toEqual(['r1'])
    state = applyEvent(state, ev({ seq: 2, type: 'request.resolved', request: { ...request('r1'), state: 'resolved' } }))
    expect(Object.keys(state.requests)).toEqual([])
  })

  it('tolerates request events without payloads', () => {
    let state = initialChat()
    state = applyEvent(state, ev({ seq: 1, type: 'request.opened' }))
    state = applyEvent(state, ev({ seq: 2, type: 'request.resolved' }))
    expect(Object.keys(state.requests)).toEqual([])
  })
})

describe('failed turns', () => {
  const user = (id: string): Item => item({ id, kind: 'user_message', status: 'completed', text: 'go' })

  it('writes a failed turn into the transcript and remembers it failed', () => {
    let state = initialChat()
    state = applyEvent(state, ev({ seq: 1, type: 'turn.started' }))
    state = applyEvent(state, ev({ seq: 2, item: user('u1') }))
    state = applyEvent(state, ev({ seq: 3, type: 'turn.ended', result: { isError: true, error: 'API Error: overloaded' } }))
    expect(state.lastTurnFailed).toBe(true)
    const id = state.order.at(-1)!
    expect(state.items[id]).toMatchObject({ kind: 'error', status: 'failed', name: TURN_FAILED, text: 'API Error: overloaded', sessionId: 's1' })
    state = applyEvent(state, ev({ seq: 4, type: 'turn.started' }))
    expect(state.lastTurnFailed).toBe(false)
  })

  it('does not call a turn the owner stopped failed', () => {
    let state = applyEvent(initialChat(), ev({ seq: 1, item: user('u1') }))
    state = applyEvent(state, ev({ seq: 2, type: 'turn.ended', result: { isError: true, stopped: true, error: 'interrupted' } }))
    expect(state.lastTurnFailed).toBe(false)
    expect(state.order).toEqual(['u1'])
    expect(state.turnResults?.u1).toMatchObject({ stopped: true })
  })

  it('keeps a cut-off turn on record and does not call it finished or failed', () => {
    let state = applyEvent(initialChat('running'), ev({ seq: 1, item: user('u1') }))
    state = applyEvent(state, ev({ seq: 2, type: 'turn.ended', result: { interruptionReason: 'crashed' } }))
    expect(state.status).toBe('interrupted')
    expect(state.lastTurnFailed).toBe(false)
    expect(state.order).toEqual(['u1'])
    expect(state.turnResults?.u1).toMatchObject({ interruptionReason: 'crashed' })
  })

  it('falls back to the result text, then to a plain sentence', () => {
    let state = applyEvent(initialChat(), ev({ seq: 1, type: 'turn.ended', result: { isError: true, text: 'Prompt is too long' } }))
    expect(state.items[state.order[0]!]!.text).toBe('Prompt is too long')
    state = applyEvent(state, ev({ seq: 2, item: user('u2') }))
    state = applyEvent(state, ev({ seq: 3, type: 'turn.ended', result: { isError: true } }))
    expect(state.items[state.order.at(-1)!]!.text).toBe('The turn ended with an error.')
  })

  it('does not repeat an error the agent already reported in this turn', () => {
    let state = initialChat()
    state = applyEvent(state, ev({ seq: 1, item: user('u1') }))
    state = applyEvent(state, ev({ seq: 2, item: item({ id: 'e1', kind: 'error', status: 'failed', text: 'boom' }) }))
    state = applyEvent(state, ev({ seq: 3, type: 'turn.ended', result: { isError: true, error: 'boom' } }))
    expect(state.order).toEqual(['u1', 'e1'])
    expect(state.lastTurnFailed).toBe(true)
  })

  it('reports an error from an earlier turn again in a new one', () => {
    let state = initialChat()
    state = applyEvent(state, ev({ seq: 1, item: item({ id: 'e1', kind: 'error', status: 'failed', text: 'boom' }) }))
    state = applyEvent(state, ev({ seq: 2, item: user('u1') }))
    state = applyEvent(state, ev({ seq: 3, type: 'turn.ended', result: { isError: true, error: 'again' } }))
    expect(state.order).toHaveLength(3)
  })

  it('leaves successful and interrupted turns alone', () => {
    let state = applyEvent(initialChat(), ev({ seq: 1, type: 'turn.ended', result: { text: 'ok' } }))
    expect(state.order).toEqual([])
    expect(state.lastTurnFailed).toBe(false)
    state = applyEvent(state, ev({ seq: 2, type: 'turn.ended', result: { isError: true, error: 'x', interruptionReason: 'crashed' } as TurnResult }))
    expect(state.order).toEqual([])
    expect(state.lastTurnFailed).toBe(false)
    state = applyEvent(state, ev({ seq: 3, type: 'turn.ended' }))
    expect(state.lastTurnFailed).toBe(false)
  })

  it('is idempotent on replay and works inside a batch', () => {
    const events: SessionEvent[] = [
      ev({ seq: 1, item: user('u1') }),
      ev({ seq: 2, type: 'turn.ended', result: { isError: true, error: 'boom' } }),
      ev({ seq: 3, item: item({ id: 'a2', text: 'later' }) }),
    ]
    const once = applyEvents(initialChat(), events)
    expect(once.order).toHaveLength(3)
    expect(once.items[once.order[1]!]!.kind).toBe('error')
    expect(applyEvents(once, events)).toBe(once)
  })
})

describe('turn results', () => {
  it('keeps each turn result under the last item the turn shows', () => {
    const first = { inputTokens: 10, outputTokens: 5, costUsd: 0.01 }
    const second = { inputTokens: 20 }
    const state = applyEvents(initialChat(), [
      ev({ seq: 1, item: item({ id: 'u1', kind: 'user_message' }) }),
      ev({ seq: 2, item: item({ id: 'a1' }) }),
      ev({ seq: 3, item: item({ id: 'child', kind: 'tool_call', parentItemId: 'a1' }) }),
      ev({ seq: 4, type: 'turn.ended', result: first }),
      ev({ seq: 5, item: item({ id: 'u2', kind: 'user_message' }) }),
      ev({ seq: 6, item: item({ id: 'a2' }) }),
      ev({ seq: 7, item: item({ id: 'blank', status: 'completed', text: '' }) }),
      ev({ seq: 8, type: 'turn.ended', result: second }),
    ])
    expect(state.turnResults).toEqual({ a1: first, a2: second })
    expect(state.result).toBe(second)
  })

  it('puts a failed turn result on its error line', () => {
    const state = applyEvents(initialChat(), [
      ev({ seq: 1, item: item({ id: 'u1', kind: 'user_message' }) }),
      ev({ seq: 2, type: 'turn.ended', result: { isError: true, error: 'boom', inputTokens: 3 } }),
    ])
    const error = state.order[1]!
    expect(state.turnResults?.[error]).toMatchObject({ inputTokens: 3 })
  })

  it('keeps nothing for a turn without a result or without items', () => {
    let state = applyEvent(initialChat(), ev({ seq: 1, type: 'turn.ended', result: { inputTokens: 1 } }))
    expect(state.turnResults).toBeUndefined()
    state = applyEvent(state, ev({ seq: 2, item: item({ id: 'a' }) }))
    state = applyEvent(state, ev({ seq: 3, type: 'turn.ended' }))
    expect(state.turnResults).toBeUndefined()
  })
})
