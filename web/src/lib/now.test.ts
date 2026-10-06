import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useNow } from './now'

afterEach(() => vi.useRealTimers())

describe('useNow', () => {
  it('ticks at the interval', () => {
    vi.useFakeTimers({ now: 1000 })
    const { result } = renderHook(() => useNow(500))
    expect(result.current).toBe(1000)
    act(() => vi.advanceTimersByTime(500))
    expect(result.current).toBe(1500)
  })

  it('stays put while paused', () => {
    vi.useFakeTimers({ now: 1000 })
    const { result } = renderHook(() => useNow(null))
    act(() => vi.advanceTimersByTime(5000))
    expect(result.current).toBe(1000)
  })

  it('stops ticking when unmounted', () => {
    vi.useFakeTimers({ now: 1000 })
    const { unmount } = renderHook(() => useNow(100))
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
