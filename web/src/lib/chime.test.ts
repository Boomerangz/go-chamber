import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from './api'
import { chimeFor, chimeOnEvent, setSoundOn, soundOn } from './chime'
import { presenceClient, resetPresence, setActiveClient, setPresenceSession } from './presence'

const ev = (type: SessionEvent['type']): SessionEvent => ({ seq: 1, sessionId: 's', type }) as SessionEvent

let tones: number
let clock = 0
beforeEach(() => {
  localStorage.clear()
  resetPresence()
  tones = 0
  class FakeContext {
    currentTime = 0
    state = 'running'
    destination = {}
    resume = vi.fn()
    createOscillator() {
      tones++
      return { frequency: { setValueAtTime: vi.fn() }, type: '', connect: vi.fn(), start: vi.fn(), stop: vi.fn() }
    }
    createGain() {
      return { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() }
    }
  }
  vi.stubGlobal('AudioContext', FakeContext)
  vi.useFakeTimers()
  // the burst guard remembers the last chime: start every test well after it
  vi.setSystemTime(++clock * 60_000)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('chimeFor', () => {
  it('chimes for what needs the owner and for a finished turn only', () => {
    expect(chimeFor(ev('request.opened'))).toBe('request')
    expect(chimeFor(ev('turn.ended'))).toBe('done')
    expect(chimeFor(ev('turn.started'))).toBeNull()
    expect(chimeFor(ev('request.resolved'))).toBeNull()
  })
})

describe('sound setting', () => {
  it('is off until turned on, and is remembered', () => {
    expect(soundOn()).toBe(false)
    setSoundOn(true)
    expect(soundOn()).toBe(true)
    setSoundOn(false)
    expect(soundOn()).toBe(false)
  })
})

describe('chimeOnEvent', () => {
  it('stays silent while sound is off', () => {
    chimeOnEvent(ev('request.opened'))
    expect(tones).toBe(0)
  })

  it('plays a two-note chime for a request and one for a finished turn', () => {
    setSoundOn(true)
    chimeOnEvent(ev('request.opened'))
    expect(tones).toBe(2)
    vi.advanceTimersByTime(1000)
    chimeOnEvent(ev('turn.ended'))
    expect(tones).toBe(3)
    chimeOnEvent(ev('turn.started'))
    expect(tones).toBe(3)
  })

  it('plays one chime for a burst of events', () => {
    setSoundOn(true)
    chimeOnEvent(ev('turn.ended'))
    chimeOnEvent(ev('turn.ended'))
    expect(tones).toBe(1)
    vi.advanceTimersByTime(1000)
    chimeOnEvent(ev('turn.ended'))
    expect(tones).toBe(2)
  })

  it('stays silent where the browser has no audio', () => {
    vi.stubGlobal('AudioContext', undefined)
    setSoundOn(true)
    expect(() => chimeOnEvent(ev('request.opened'))).not.toThrow()
  })

  it('sounds only on the page the owner was at last, on whichever device', () => {
    setSoundOn(true)
    setActiveClient('the-phone')
    chimeOnEvent(ev('turn.ended'))
    expect(tones).toBe(0)
    setActiveClient(presenceClient())
    chimeOnEvent(ev('turn.ended'))
    expect(tones).toBe(1)
  })

  it('sounds on a focused page showing that session even if the owner was elsewhere last', () => {
    setSoundOn(true)
    setActiveClient('the-phone')
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    setPresenceSession('other')
    chimeOnEvent(ev('turn.ended'))
    expect(tones).toBe(0)
    setPresenceSession('s')
    chimeOnEvent(ev('turn.ended'))
    expect(tones).toBe(1)
  })

})
