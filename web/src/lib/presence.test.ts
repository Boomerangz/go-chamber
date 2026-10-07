import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindPresence, chimesHere, presenceClient, resetPresence, setActiveClient, setPresenceSession, startPresence, watchingHere } from './presence'

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}
const setFocus = (on: boolean) => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(on)
  window.dispatchEvent(new Event(on ? 'focus' : 'blur'))
}
const frames = (send: ReturnType<typeof vi.fn>) => send.mock.calls.map(([f]) => JSON.parse(f as string) as Record<string, unknown>)

beforeEach(() => {
  resetPresence()
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})
afterEach(() => vi.restoreAllMocks())

describe('presence', () => {
  it('tells the server what this page shows as soon as the socket opens', () => {
    const send = vi.fn()
    setPresenceSession('s1')
    bindPresence(send)
    expect(frames(send)).toEqual([{ type: 'presence', client: presenceClient(), session: 's1', visible: true, focused: true }])
  })

  it('tells it again when the page hides, loses focus or opens another session', () => {
    startPresence()
    const send = vi.fn()
    bindPresence(send)
    send.mockClear()
    setFocus(false)
    setVisibility('hidden')
    setPresenceSession('s2')
    expect(frames(send).map((f) => [f.visible, f.focused, f.session])).toEqual([
      [true, false, undefined],
      [false, false, undefined],
      [false, false, 's2'],
    ])
  })

  it('says nothing while the socket is down', () => {
    startPresence()
    const send = vi.fn()
    bindPresence(send)
    bindPresence(null)
    send.mockClear()
    setPresenceSession('s3')
    expect(send).not.toHaveBeenCalled()
  })

  it('chimes only on the page the owner was at last, anywhere', () => {
    // Before the server says, every page chimes as it used to.
    expect(chimesHere()).toBe(true)
    setActiveClient('another-page')
    expect(chimesHere()).toBe(false)
    setActiveClient(presenceClient())
    expect(chimesHere()).toBe(true)
    // No page open anywhere that counts: chime here rather than nowhere.
    setActiveClient('')
    expect(chimesHere()).toBe(true)
  })

  it('knows the session this page shows the owner right now', () => {
    setPresenceSession('s1')
    expect(watchingHere('s1')).toBe(true)
    expect(watchingHere('s2')).toBe(false)
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    expect(watchingHere('s1')).toBe(false)
  })
})
