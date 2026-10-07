import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item, Session } from './api'

vi.mock('./visits', async (actual) => ({
  ...(await actual<typeof import('./visits')>()),
  reportSeen: vi.fn(),
  flushSeen: vi.fn(),
}))

import { firstUnseen, loadSeen, saveSeen, useUnseen } from './seen'
import { flushSeen, reportSeen } from './visits'

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

describe('useUnseen', () => {
  const user = (id: string): Item => ({ id, sessionId: 's1', kind: 'user_message', status: 'completed', text: id })
  const reply = (id: string): Item => ({ id, sessionId: 's1', kind: 'assistant_message', status: 'completed', text: id })
  const itemsOf = (...list: Item[]) => Object.fromEntries(list.map((i) => [i.id, i]))
  const setVisibility = (state: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
  }
  type Props = { order: string[]; items: Record<string, Item>; ready?: boolean; pinned?: boolean; session?: Session; shown?: boolean }
  const mount = (initial: Props) =>
    renderHook(
      ({ order, items, ready = true, pinned = true, session, shown = true }: Props) =>
        useUnseen({ sessionId: 's1', session, shown, order, items, ready, pinned, isPinned: () => pinned }),
      { initialProps: initial },
    )
  const session = (extra: Partial<Session> = {}): Session => ({ id: 's1', agent: 'claude', cwd: '/p', status: 'idle', ...extra })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  it('marks what arrived since the last visit and keeps the mark while more streams in', () => {
    saveSeen('s1', 'a')
    const items = itemsOf(user('a'), reply('b'), reply('c'))
    const view = mount({ order: ['a', 'b'], items, pinned: false })
    expect(view.result.current).toBe('b')
    view.rerender({ order: ['a', 'b', 'c'], items, pinned: false })
    expect(view.result.current).toBe('b')
  })

  it('does not mark what arrives while the owner is looking', () => {
    saveSeen('s1', 'a')
    const items = itemsOf(user('a'), reply('b'), user('c'), reply('d'))
    const view = mount({ order: ['a'], items })
    expect(view.result.current).toBeNull()
    // The owner sends a message and the agent answers, all on screen.
    view.rerender({ order: ['a', 'c'], items })
    expect(view.result.current).toBeNull()
    view.rerender({ order: ['a', 'c', 'd'], items })
    expect(view.result.current).toBeNull()
  })

  it('does not mark items while scrolled up to read older ones', () => {
    saveSeen('s1', 'a')
    const items = itemsOf(user('a'), reply('b'))
    const view = mount({ order: ['a'], items, pinned: false })
    view.rerender({ order: ['a', 'b'], items, pinned: false })
    expect(view.result.current).toBeNull()
  })

  it('marks what arrived while the tab was hidden', () => {
    saveSeen('s1', 'a')
    const items = itemsOf(user('a'), reply('b'), reply('c'))
    const view = mount({ order: ['a'], items })
    setVisibility('hidden')
    view.rerender({ order: ['a', 'b'], items })
    view.rerender({ order: ['a', 'b', 'c'], items })
    setVisibility('visible')
    expect(view.result.current).toBe('b')
  })

  it('clears the mark once the owner sends a message: they have seen everything', () => {
    saveSeen('s1', 'a')
    const items = itemsOf(user('a'), reply('b'), user('c'), reply('d'))
    const view = mount({ order: ['a', 'b'], items, pinned: false })
    expect(view.result.current).toBe('b')
    view.rerender({ order: ['a', 'b', 'c'], items })
    expect(view.result.current).toBeNull()
    view.rerender({ order: ['a', 'b', 'c', 'd'], items })
    expect(view.result.current).toBeNull()
  })

  it('keeps a mark whose news include a message sent from elsewhere', () => {
    saveSeen('s1', 'a')
    const items = itemsOf(user('a'), user('b'), reply('c'))
    const view = mount({ order: ['a', 'b', 'c'], items, pinned: false })
    expect(view.result.current).toBe('b')
    view.rerender({ order: ['a', 'b', 'c'], items, pinned: true })
    expect(view.result.current).toBe('b')
  })

  it('waits for the transcript before it decides what is new', () => {
    saveSeen('s1', 'b')
    const items = itemsOf(user('a'), reply('b'), reply('c'))
    const view = mount({ order: ['a'], items, ready: false })
    view.rerender({ order: ['a', 'b', 'c'], items, ready: true })
    expect(view.result.current).toBe('c')
  })

  it('remembers the last item read only while the end is on screen', () => {
    const items = itemsOf(user('a'), reply('b'), reply('c'))
    const view = mount({ order: ['a'], items })
    expect(loadSeen('s1')).toBe('a')
    view.rerender({ order: ['a', 'b'], items, pinned: false })
    expect(loadSeen('s1')).toBe('a')
    view.rerender({ order: ['a', 'b'], items, pinned: true })
    expect(loadSeen('s1')).toBe('b')
    setVisibility('hidden')
    view.rerender({ order: ['a', 'b', 'c'], items })
    expect(loadSeen('s1')).toBe('b')
  })

  it('remembers nothing before the transcript is in', () => {
    mount({ order: ['a'], items: itemsOf(user('a')), ready: false })
    expect(loadSeen('s1')).toBeNull()
  })

  it('starts from where the owner stopped on any device', () => {
    saveSeen('s1', 'a')
    const items = itemsOf(user('a'), reply('b'), reply('c'))
    const view = mount({ order: ['a', 'b', 'c'], items, pinned: false, session: session({ seen: { item: 'b' } }) })
    expect(view.result.current).toBe('c')
  })

  it('follows what the owner read on another device while away from this one', () => {
    const items = itemsOf(user('a'), reply('b'), user('c'), reply('d'))
    const view = mount({ order: ['a', 'b'], items, session: session({ seen: { item: 'b' } }) })
    setVisibility('hidden')
    // The phone sends a message and reads the answer.
    view.rerender({ order: ['a', 'b', 'c', 'd'], items, session: session({ seen: { item: 'c' } }) })
    view.rerender({ order: ['a', 'b', 'c', 'd'], items, session: session({ seen: { item: 'd' } }) })
    setVisibility('visible')
    expect(view.result.current).toBeNull()
  })

  it('marks after the owner\'s own message from another device what they have not read', () => {
    const items = itemsOf(user('a'), reply('b'), user('c'), reply('d'))
    const view = mount({ order: ['a', 'b'], items, session: session({ seen: { item: 'b' } }) })
    setVisibility('hidden')
    view.rerender({ order: ['a', 'b', 'c', 'd'], items, session: session({ seen: { item: 'c' } }) })
    setVisibility('visible')
    expect(view.result.current).toBe('d')
  })

  it('tells the server where the owner stopped while the end is on screen', () => {
    const items = itemsOf(user('a'), reply('b'))
    const view = mount({ order: ['a', 'b'], items, session: session() })
    expect(reportSeen).toHaveBeenLastCalledWith('s1', 'b', undefined)
    vi.clearAllMocks()
    // Scrolled up after a turn ended: a look, but not a read.
    const ended = session({ seen: { item: 'b', at: '2026-10-07T09:00:00Z' }, endedAt: '2026-10-07T09:01:00Z' })
    view.rerender({ order: ['a', 'b'], items, pinned: false, session: ended })
    expect(reportSeen).toHaveBeenLastCalledWith('s1', undefined, '2026-10-07T09:01:00Z')
  })

  it('tells nothing the server knows, nor while the chat is not in front', () => {
    const items = itemsOf(user('a'), reply('b'))
    const known = session({ seen: { item: 'b', at: '2026-10-07T09:01:00Z' }, endedAt: '2026-10-07T09:01:00Z' })
    const view = mount({ order: ['a', 'b'], items, session: known })
    expect(reportSeen).not.toHaveBeenCalled()
    view.rerender({ order: ['a', 'b'], items, session: session(), shown: false })
    expect(reportSeen).not.toHaveBeenCalled()
    expect(flushSeen).toHaveBeenCalledWith('s1')
  })

  it('tells a waiting look at once when the page goes away or the session closes', () => {
    const view = mount({ order: ['a'], items: itemsOf(user('a')), session: session() })
    setVisibility('hidden')
    expect(flushSeen).toHaveBeenCalledWith('s1')
    vi.clearAllMocks()
    view.unmount()
    expect(flushSeen).toHaveBeenCalledWith('s1')
  })
})
