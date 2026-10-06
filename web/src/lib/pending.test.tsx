import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { usePending } from './pending'

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
