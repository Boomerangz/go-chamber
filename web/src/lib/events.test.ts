import { describe, expect, it } from 'vitest'
import { applyEvent, initialChat } from './events'
import type { Item, SessionEvent, SessionRequest } from './api'

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
