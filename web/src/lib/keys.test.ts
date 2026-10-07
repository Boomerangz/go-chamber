import { describe, expect, it } from 'vitest'
import { keyGroups } from './keys'

describe('keyGroups', () => {
  it('splits alternatives on "·" and a chord into its keys, one per box', () => {
    expect(keyGroups('a · s · d')).toEqual([['a'], ['s'], ['d']])
    expect(keyGroups('Esc')).toEqual([['Esc']])
    expect(keyGroups('↵')).toEqual([['↵']])
  })

  it('takes a Mac chord apart glyph by glyph', () => {
    expect(keyGroups('⇧↵')).toEqual([['⇧', '↵']])
    expect(keyGroups('⌘.')).toEqual([['⌘', '.']])
    expect(keyGroups('⌘⇧F')).toEqual([['⌘', '⇧', 'F']])
    expect(keyGroups('⌥[ · ⌥]')).toEqual([['⌥', '['], ['⌥', ']']])
    expect(keyGroups('Enter · ⌘↵')).toEqual([['Enter'], ['⌘', '↵']])
  })

  it('takes a written-out chord apart on "+"', () => {
    expect(keyGroups('Ctrl+Shift+F')).toEqual([['Ctrl', 'Shift', 'F']])
    expect(keyGroups('Ctrl+= · Ctrl+- · Ctrl+0')).toEqual([['Ctrl', '='], ['Ctrl', '-'], ['Ctrl', '0']])
    expect(keyGroups('Alt+[')).toEqual([['Alt', '[']])
  })

  it('keeps keys pressed in turn together in one group', () => {
    expect(keyGroups('↑ ↓')).toEqual([['↑', '↓']])
  })

  it('reads a lone "+" or "·" as a key', () => {
    expect(keyGroups('+')).toEqual([['+']])
    expect(keyGroups('')).toEqual([])
  })
})
