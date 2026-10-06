import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { describeError, lastError, notify, resetNotices, useNotices } from './notices'

const notices = () => useNotices.getState().notices

beforeEach(() => resetNotices())
afterEach(() => vi.useRealTimers())

describe('notices', () => {
  it('queues errors with the failed action as title', () => {
    notify({ kind: 'error', title: 'Fork failed', text: 'nope' })
    expect(notices()).toMatchObject([{ kind: 'error', title: 'Fork failed', text: 'nope' }])
    expect(lastError()).toBe('nope')
  })

  it('replaces a notice with the same key instead of stacking it', () => {
    notify({ kind: 'error', text: 'one', key: 'send' })
    notify({ kind: 'error', text: 'two', key: 'send' })
    expect(notices().map((n) => n.text)).toEqual(['two'])
  })

  it('keeps at most three, dropping the oldest', () => {
    for (const text of ['a', 'b', 'c', 'd']) notify({ kind: 'error', text })
    expect(notices().map((n) => n.text)).toEqual(['b', 'c', 'd'])
  })

  it('dismisses by id and by key', () => {
    const id = notify({ kind: 'error', text: 'a' })
    notify({ kind: 'error', text: 'b', key: 'k' })
    useNotices.getState().dismiss(id)
    expect(notices().map((n) => n.text)).toEqual(['b'])
    useNotices.getState().dismissKey('k')
    expect(notices()).toEqual([])
    expect(lastError()).toBeNull()
  })

  it('hides info notices on their own, but keeps errors', () => {
    vi.useFakeTimers()
    notify({ kind: 'info', text: 'copied' })
    notify({ kind: 'error', text: 'broken' })
    vi.advanceTimersByTime(4000)
    expect(notices().map((n) => n.text)).toEqual(['broken'])
  })
})

describe('describeError', () => {
  it('uses the message of an Error', () => {
    expect(describeError(new Error('exit status 1'))).toBe('exit status 1')
  })

  it('reduces an HTML error page to its title', () => {
    expect(describeError(new Error('<html><head><title>502 Bad Gateway</title></head><body>…</body></html>'))).toBe('502 Bad Gateway')
  })

  it('names a dropped connection plainly', () => {
    expect(describeError(new TypeError('Failed to fetch'))).toBe('go-chamber is not reachable')
  })

  it('trims long messages', () => {
    expect(describeError('x'.repeat(400))).toHaveLength(241)
  })
})
