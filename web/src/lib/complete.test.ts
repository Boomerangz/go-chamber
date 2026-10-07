import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyCompletion, completeFiles, filterCommands, findToken, forgetCommands, listCommands } from './complete'

describe('findToken', () => {
  it('finds an @ mention ending at the caret', () => {
    expect(findToken('look at @src/ma', 15, 'claude')).toEqual({ kind: 'file', query: 'src/ma', start: 8, end: 15 })
    expect(findToken('@', 1, 'claude')).toEqual({ kind: 'file', query: '', start: 0, end: 1 })
  })

  it('ignores @ inside a word, like an email', () => {
    expect(findToken('mail me@host', 12, 'claude')).toBeNull()
  })

  it('finds a slash command only at the start of the message', () => {
    expect(findToken('/rev', 4, 'claude')).toEqual({ kind: 'command', query: 'rev', start: 0, end: 4 })
    expect(findToken('  /rev', 6, 'claude')).toEqual({ kind: 'command', query: 'rev', start: 2, end: 6 })
    expect(findToken('see /rev', 8, 'claude')).toBeNull()
    expect(findToken('/review now', 11, 'claude')).toBeNull()
  })

  it('finds a codex $skill anywhere', () => {
    expect(findToken('use $pd', 7, 'codex')).toEqual({ kind: 'command', query: 'pd', start: 4, end: 7 })
    expect(findToken('use $pd', 7, 'claude')).toBeNull()
  })

  it('only looks at the word under the caret', () => {
    expect(findToken('@a b', 4, 'claude')).toBeNull()
    expect(findToken('@abc more', 2, 'claude')).toEqual({ kind: 'file', query: 'a', start: 0, end: 4 })
  })
})

describe('applyCompletion', () => {
  it('replaces the token and adds a space after a file', () => {
    const token = findToken('see @ma now', 7, 'claude')!
    expect(applyCompletion('see @ma now', token, '@main.go', false)).toEqual({ text: 'see @main.go now', caret: 13 })
  })

  it('keeps a folder open for more typing', () => {
    const token = findToken('@cm', 3, 'claude')!
    expect(applyCompletion('@cm', token, '@cmd/', true)).toEqual({ text: '@cmd/', caret: 5 })
  })
})

describe('filterCommands', () => {
  const cmds = [
    { name: 'compact', insert: '/compact' },
    { name: 'review-mr', insert: '/review-mr' },
    { name: 'mr-review', insert: '/mr-review' },
    { name: 'clear', insert: '/clear', description: 'Start over' },
  ]
  it('puts prefix matches before other matches', () => {
    expect(filterCommands(cmds, 'rev').map((c) => c.name)).toEqual(['review-mr', 'mr-review'])
  })
  it('lists everything for an empty query', () => {
    expect(filterCommands(cmds, '')).toHaveLength(4)
  })
})

describe('listCommands', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  const stubFetch = () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify([{ name: 'compact', insert: '/compact' }])))
    vi.stubGlobal('fetch', fetch)
    return fetch
  }

  it('asks once per session while the list is fresh', async () => {
    const fetch = stubFetch()
    await listCommands('fresh')
    await listCommands('fresh')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('asks again after a while: skills and commands change on disk', async () => {
    vi.useFakeTimers()
    const fetch = stubFetch()
    await listCommands('stale')
    vi.advanceTimersByTime(5 * 60_000 + 1)
    await listCommands('stale')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('asks again once forgotten, e.g. when the turn ends', async () => {
    const fetch = stubFetch()
    await listCommands('forget')
    forgetCommands('forget')
    expect((await listCommands('forget'))[0]?.name).toBe('compact')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe('completeFiles', () => {
  afterEach(() => vi.unstubAllGlobals())

  it("gives the server's reason when the listing fails", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"session not found"}', { status: 404, statusText: 'Not Found' })))
    await expect(completeFiles('s1', 'src')).rejects.toThrow('session not found')
  })

  it('falls back to the status when the server says nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500, statusText: 'Internal Server Error' })))
    await expect(completeFiles('s1', 'src')).rejects.toThrow('500 Internal Server Error')
  })
})
