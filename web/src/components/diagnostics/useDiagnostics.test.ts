import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { diagnostics, resetDiagnostics } from '../../lib/diagnostics'
import { useDiagnostics } from './useDiagnostics'

class EchoSocket {
  static OPEN = 1
  static instances: EchoSocket[] = []
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  send = vi.fn((data: string) => this.onmessage?.({ data }))
  close = vi.fn(() => this.onclose?.())
  constructor() { EchoSocket.instances.push(this) }
}
const snapshot = { uptimeSeconds: 60, goroutines: 8, heapBytes: 1024, events: {}, terminals: [] }

beforeEach(() => {
  vi.useFakeTimers()
  resetDiagnostics()
  EchoSocket.instances = []
  vi.stubGlobal('WebSocket', EchoSocket)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('records successful probes and closes all resources on pause', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => snapshot })
  vi.stubGlobal('fetch', fetcher)
  const { result, rerender, unmount } = renderHook(({ enabled }) => useDiagnostics(enabled), { initialProps: { enabled: true } })
  await act(async () => { EchoSocket.instances[0].onopen?.() })
  expect(result.current.server).toEqual(snapshot)
  expect(diagnostics().metrics.http.count).toBe(1)
  expect(diagnostics().metrics.ws.count).toBe(1)
  rerender({ enabled: false })
  expect(EchoSocket.instances[0].close).toHaveBeenCalledOnce()
  const signal = fetcher.mock.calls[0][1].signal as AbortSignal
  expect(signal.aborted).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
  expect(fetcher).toHaveBeenCalledOnce()
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('recovers from a timed-out HTTP probe with a fresh request signal', async () => {
  const fetcher = vi.fn()
    .mockImplementationOnce((_url, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('timed out')))
    }))
    .mockResolvedValue({ ok: true, json: async () => snapshot })
  vi.stubGlobal('fetch', fetcher)
  const { result, unmount } = renderHook(() => useDiagnostics(true))
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(result.current.error).toBe('timed out')
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher.mock.calls[1][1].signal.aborted).toBe(false)
  expect(result.current.error).toBeNull()
  expect(result.current.server).toEqual(snapshot)
  unmount()
})

it('reports HTTP failures without recording a successful sample', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }))
  const { result, unmount } = renderHook(() => useDiagnostics(true))
  await act(async () => {})
  expect(result.current.error).toContain('401')
  expect(diagnostics().metrics.http.count).toBe(0)
  unmount()
})
