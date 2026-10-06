import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOLD_TIMEOUT_MS, usePending } from './pending'

function deferred() {
  let resolve: (v: boolean) => void = () => {}
  const promise = new Promise<boolean>((r) => (resolve = r))
  return { promise, resolve }
}

describe('usePending', () => {
  it('is pending while the action runs and ignores a second trigger', async () => {
    const d = deferred()
    let calls = 0
    const { result } = renderHook(() => usePending(() => { calls++; return d.promise }))
    let first: Promise<boolean | undefined> = Promise.resolve(undefined)
    act(() => { first = result.current[0]() })
    expect(result.current[1]).toBe(true)
    let second: boolean | undefined = true
    await act(async () => { second = await result.current[0]() })
    expect(second).toBeUndefined()
    expect(calls).toBe(1)
    await act(async () => { d.resolve(true); await first })
    expect(result.current[1]).toBe(false)
    expect(await first).toBe(true)
  })

  it('clears pending when the action throws', async () => {
    const { result } = renderHook(() => usePending(() => Promise.reject(new Error('x'))))
    await act(async () => { await result.current[0]().catch(() => {}) })
    expect(result.current[1]).toBe(false)
  })

  it('can stay pending after success until the caller is replaced', async () => {
    const { result } = renderHook(() => usePending(() => Promise.resolve(true), { holdOnSuccess: true }))
    await act(async () => { await result.current[0]() })
    expect(result.current[1]).toBe(true)
  })
})

describe('usePending hold timeout', () => {
  afterEach(() => vi.useRealTimers())

  it('releases a held control when the confirming event never comes', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => usePending(() => Promise.resolve(true), { holdOnSuccess: true }))
    await act(async () => { await result.current[0]() })
    expect(result.current[1]).toBe(true)
    expect(result.current[2]).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(HOLD_TIMEOUT_MS - 1) })
    expect(result.current[1]).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(result.current[1]).toBe(false)
    // it went through: the caller can say it waits on the agent
    expect(result.current[2]).toBe(true)
  })

  it('takes its own hold timeout and runs again once released', async () => {
    vi.useFakeTimers()
    let calls = 0
    const { result } = renderHook(() =>
      usePending(() => { calls++; return Promise.resolve(true) }, { holdOnSuccess: true, holdTimeoutMs: 50 }),
    )
    await act(async () => { await result.current[0]() })
    await act(async () => { await result.current[0]() })
    expect(calls).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(result.current[2]).toBe(true)
    let next: Promise<boolean | undefined> = Promise.resolve(undefined)
    act(() => { next = result.current[0]() })
    // a new attempt is no longer waiting on the old one
    expect(result.current[2]).toBe(false)
    await act(async () => { await next })
    expect(calls).toBe(2)
  })

  it('holds for good with a zero timeout', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => usePending(() => Promise.resolve(true), { holdOnSuccess: true, holdTimeoutMs: 0 }))
    await act(async () => { await result.current[0]() })
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(result.current[1]).toBe(true)
  })

  it('stops its clock when the control leaves', async () => {
    vi.useFakeTimers()
    const { result, unmount } = renderHook(() => usePending(() => Promise.resolve(true), { holdOnSuccess: true }))
    await act(async () => { await result.current[0]() })
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not hold a refused action', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => usePending(() => Promise.resolve(false), { holdOnSuccess: true }))
    await act(async () => { await result.current[0]() })
    expect(result.current[1]).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
