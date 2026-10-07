import { describe, expect, it } from 'vitest'
import { RecentCache } from './chat-cache'

describe('RecentCache', () => {
  it('keeps the most recently stored keys up to its size', () => {
    const c = new RecentCache<number>(2)
    c.put('a', 1)
    c.put('b', 2)
    c.put('a', 3)
    c.put('c', 4)
    expect(c.get('a')).toBe(3)
    expect(c.get('b')).toBeUndefined()
    expect(c.get('c')).toBe(4)
  })

  it('forgets a key, or everything', () => {
    const c = new RecentCache<number>(3)
    c.put('a', 1)
    c.put('b', 2)
    c.delete('a')
    expect(c.get('a')).toBeUndefined()
    expect(c.get('b')).toBe(2)
    c.clear()
    expect(c.get('b')).toBeUndefined()
  })
})
