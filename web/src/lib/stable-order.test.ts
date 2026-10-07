import { beforeEach, describe, expect, it } from 'vitest'
import { keepOrder, resetStableOrders, stableOrder } from './stable-order'

describe('keepOrder', () => {
  it('takes the first order as it comes', () => {
    expect(keepOrder(['b', 'a', 'c'], [])).toEqual({ order: ['b', 'a', 'c'], memory: ['b', 'a', 'c'] })
  })
  it('keeps known keys where they were, whatever their new order', () => {
    expect(keepOrder(['c', 'a', 'b'], ['a', 'b', 'c']).order).toEqual(['a', 'b', 'c'])
  })
  it('puts new keys on top, in the order they come', () => {
    expect(keepOrder(['d', 'b', 'e', 'a'], ['a', 'b']).order).toEqual(['d', 'e', 'a', 'b'])
  })
  it('remembers keys that are away, so they come back to their place', () => {
    const away = keepOrder(['c', 'a'], ['a', 'b', 'c'])
    expect(away.order).toEqual(['a', 'c'])
    expect(keepOrder(['b', 'c', 'a'], away.memory).order).toEqual(['a', 'b', 'c'])
  })
})

describe('stableOrder', () => {
  beforeEach(resetStableOrders)

  it('remembers each list apart, until reset', () => {
    stableOrder('groups', ['x', 'y'])
    stableOrder('chips', ['y', 'x'])
    expect(stableOrder('groups', ['y', 'x'])).toEqual(['x', 'y'])
    expect(stableOrder('chips', ['x', 'y'])).toEqual(['y', 'x'])
    resetStableOrders()
    expect(stableOrder('groups', ['y', 'x'])).toEqual(['y', 'x'])
  })

  it('sorts items by their key', () => {
    const items = [{ k: 'a' }, { k: 'b' }]
    stableOrder('items', ['b', 'a'])
    expect(stableOrder.by('items', items, (i) => i.k).map((i) => i.k)).toEqual(['b', 'a'])
  })
})
