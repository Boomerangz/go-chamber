import { afterEach, expect, it, vi } from 'vitest'
import { onRTCChange, rtcEnabled, setRTCEnabled } from './transport'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

it('uses WebRTC unless this device turned it off', () => {
  expect(rtcEnabled()).toBe(true)
  setRTCEnabled(false)
  expect(rtcEnabled()).toBe(false)
  expect(localStorage.getItem('gc.terminal.rtc')).toBe('off')
  setRTCEnabled(true)
  expect(rtcEnabled()).toBe(true)
})

it('tells subscribers about changes until they unsubscribe', () => {
  const seen: boolean[] = []
  const stop = onRTCChange((on) => seen.push(on))
  setRTCEnabled(false)
  setRTCEnabled(true)
  stop()
  setRTCEnabled(false)
  expect(seen).toEqual([false, true])
})

it('keeps the choice for this page when storage is unavailable', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
  expect(rtcEnabled()).toBe(true)
  setRTCEnabled(false)
  expect(rtcEnabled()).toBe(false)
  setRTCEnabled(true)
})
