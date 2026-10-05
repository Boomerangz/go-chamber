import { describe, expect, it } from 'vitest'
import { applyEvent, applyEvents, initialChat } from './events'
import type { Item, SessionEvent } from './api'

const fold = applyEvents
const message = (id: string): Item => ({ id, sessionId: 's', kind: 'assistant_message', status: 'streaming', text: '' })
const delta = (seq: number, id: string, text: string): SessionEvent => ({ seq, sessionId: 's', type: 'text.delta', delta: { itemId: id, text } })

describe('batched events', () => {
  it('visits the existing item map only once per streaming batch', () => {
    let scans = 0
    const items = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`i${i}`, Object.freeze(message(`i${i}`))]))
    const state = Object.freeze({ ...initialChat(), items: new Proxy(Object.freeze(items), {
      ownKeys(target) { scans++; return Reflect.ownKeys(target) },
    }), order: Object.freeze(Object.keys(items)) as unknown as string[] })
    const events = Array.from({ length: 200 }, (_, i) => delta(i + 1, 'i4999', 'x'))
    const baselineStart = performance.now()
    events.reduce(applyEvent, state)
    const baselineMs = performance.now() - baselineStart
    scans = 0
    const started = performance.now()
    const updated = fold(state, events)
    const batchMs = performance.now() - started
    expect(batchMs).toBeLessThan(baselineMs / 5)
    expect(updated.items.i4999.text).toBe('x'.repeat(200))
    expect(scans).toBe(1)
    expect(state.items.i4999.text).toBe('')
    expect(updated.items.i1).toBe(state.items.i1)
    expect(updated.order).toBe(state.order)
  })

  it('preserves sequential semantics, sequence filtering and immutable input', () => {
    const state = initialChat()
    Object.freeze(state.items)
    Object.freeze(state.order)
    Object.freeze(state.requests)
    Object.freeze(state)
    const request = { id: 'r', sessionId: 's', kind: 'permission' as const, state: 'pending' as const, title: 'Run' }
    const events: SessionEvent[] = [
      { seq: 1, sessionId: 's', type: 'item.updated', item: message('a') },
      delta(2, 'a', 'one'),
      delta(2, 'a', 'duplicate'),
      delta(3, 'missing', 'ignored'),
      { seq: 4, sessionId: 's', type: 'turn.started' },
      { seq: 5, sessionId: 's', type: 'request.opened', request },
      { seq: 6, sessionId: 's', type: 'request.resolved', request },
      { seq: 7, sessionId: 's', type: 'usage', usage: { totalTokens: 42 } },
      { seq: 8, sessionId: 's', type: 'item.updated', item: { ...message('a'), text: 'final', status: 'completed' } },
      { seq: 9, sessionId: 's', type: 'turn.ended', result: { text: 'done' } },
    ]
    const updated = fold(state, events)
    expect(updated).toEqual(events.reduce(applyEvent, state))
    expect(updated.order).toEqual(['a'])
    expect(state).toEqual(initialChat())
    expect(fold(updated, events)).toBe(updated)
    expect(fold(state, [])).toBe(state)
  })
})
