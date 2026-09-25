import { beforeEach, describe, expect, it, vi } from 'vitest'
import { firstUnseen, loadSeen, saveSeen } from './seen'

describe('firstUnseen', () => {
  it('points at the item after the last one seen', () => {
    expect(firstUnseen(['a', 'b', 'c'], 'a')).toBe('b')
    expect(firstUnseen(['a', 'b', 'c'], 'b')).toBe('c')
  })

  it('has nothing to mark when everything was seen', () => {
    expect(firstUnseen(['a', 'b'], 'b')).toBeNull()
  })

  it('has nothing to mark for a session never opened', () => {
    expect(firstUnseen(['a', 'b'], null)).toBeNull()
  })

  it('has nothing to mark when the seen item is gone', () => {
    expect(firstUnseen(['a', 'b'], 'zz')).toBeNull()
  })
})

describe('loadSeen / saveSeen', () => {
  beforeEach(() => localStorage.clear())

  it('remembers the last seen item per session', () => {
    saveSeen('s1', 'i9')
    saveSeen('s2', 'i3')
    expect(loadSeen('s1')).toBe('i9')
    expect(loadSeen('s2')).toBe('i3')
  })

  it('returns null for an unknown session', () => {
    expect(loadSeen('nope')).toBeNull()
  })

  it('survives storage that throws', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(loadSeen('s1')).toBeNull()
    expect(() => saveSeen('s1', 'i1')).not.toThrow()
    get.mockRestore()
    set.mockRestore()
  })
})
