import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { describeError, fail, lastError, notify, resetNotices, useNotices } from './notices'

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

  it('keeps a notice with an action twice as long as a plain one', () => {
    vi.useFakeTimers()
    notify({ kind: 'info', text: 'plain' })
    notify({ kind: 'info', text: 'Archived x', action: { label: 'Undo', run: () => {} } })
    vi.advanceTimersByTime(4000)
    expect(notices().map((n) => n.text)).toEqual(['Archived x'])
    vi.advanceTimersByTime(4000)
    expect(notices()).toEqual([])
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

  it('names a request go-chamber never answered', () => {
    expect(describeError(new DOMException('signal timed out', 'TimeoutError'))).toBe("go-chamber didn't answer")
  })

  it('trims long messages', () => {
    expect(describeError('x'.repeat(400))).toHaveLength(241)
  })
})

describe('quiet failures', () => {
  it('names the reason for the caller that shows it in place, without a notice', () => {
    fail('Answer not sent', new Error('gone'), 'answer', { quiet: true })
    expect(useNotices.getState().notices).toEqual([])
    expect(lastError()).toBe('gone')
  })

  it('gives the newest reason, shown or quiet', () => {
    fail('A', new Error('loud'))
    fail('B', new Error('quiet'), 'b', { quiet: true })
    expect(lastError()).toBe('quiet')
    fail('C', new Error('louder'))
    expect(lastError()).toBe('louder')
  })

  it('forgets a quiet failure once its action succeeds or the notices reset', () => {
    fail('B', new Error('quiet'), 'b', { quiet: true })
    useNotices.getState().dismissKey('b')
    expect(lastError()).toBeNull()
    const id = notify({ kind: 'error', text: 'x' })
    fail('B', new Error('quiet'), 'b', { quiet: true })
    useNotices.getState().dismiss(id)
    expect(lastError()).toBe('quiet')
    resetNotices()
    expect(lastError()).toBeNull()
  })
})
