import { describe, expect, it } from 'vitest'
import { applyCompletion, filterCommands, findToken } from './complete'

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
