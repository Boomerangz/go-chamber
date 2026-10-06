import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useJustFinished } from './finished'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useJustFinished', () => {
  it('flags a turn that went from running to idle, then lets it fade', () => {
    const { result, rerender } = renderHook(({ s }) => useJustFinished(s), { initialProps: { s: 'running' } })
    expect(result.current).toBe(false)
    rerender({ s: 'idle' })
    expect(result.current).toBe(true)
    act(() => vi.advanceTimersByTime(1500))
    expect(result.current).toBe(false)
  })

  it('ignores a session that loads idle', () => {
    const { result } = renderHook(() => useJustFinished('idle'))
    expect(result.current).toBe(false)
  })

  it('does not call an interrupted turn finished', () => {
    const { result, rerender } = renderHook(({ s }) => useJustFinished(s), { initialProps: { s: 'running' } })
    rerender({ s: 'interrupted' })
    expect(result.current).toBe(false)
  })

  it('drops the flag as soon as the next turn starts', () => {
    const { result, rerender } = renderHook(({ s }) => useJustFinished(s), { initialProps: { s: 'running' } })
    rerender({ s: 'idle' })
    rerender({ s: 'running' })
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(1500))
    expect(result.current).toBe(false)
  })

  it('does not call a failed turn done', () => {
    const { result, rerender } = renderHook(({ s, failed }) => useJustFinished(s, failed), { initialProps: { s: 'running', failed: false } })
    rerender({ s: 'idle', failed: true })
    expect(result.current).toBe(false)
  })
})
