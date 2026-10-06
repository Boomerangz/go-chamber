import { describe, expect, it } from 'vitest'
import { terminalAction, type KeyLike } from './terminal-keys'

const key = (over: Partial<KeyLike>): KeyLike => ({
  type: 'keydown', key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over,
})

describe('terminalAction on a Mac', () => {
  const mac = (over: Partial<KeyLike>) => terminalAction(key(over), true)

  it('finds with ⌘F and sizes the font with ⌘+ ⌘− ⌘0', () => {
    expect(mac({ metaKey: true, key: 'f', code: 'KeyF' })).toBe('find')
    expect(mac({ metaKey: true, key: '=', code: 'Equal' })).toBe('font-up')
    expect(mac({ metaKey: true, shiftKey: true, key: '+', code: 'Equal' })).toBe('font-up')
    expect(mac({ metaKey: true, key: '-', code: 'Minus' })).toBe('font-down')
    expect(mac({ metaKey: true, key: '0', code: 'Digit0' })).toBe('font-reset')
  })

  it('leaves copy, paste, Ctrl chords and key-ups alone', () => {
    expect(mac({ metaKey: true, key: 'c', code: 'KeyC' })).toBeNull()
    expect(mac({ metaKey: true, key: 'v', code: 'KeyV' })).toBeNull()
    expect(mac({ ctrlKey: true, key: 'c', code: 'KeyC' })).toBeNull()
    expect(mac({ ctrlKey: true, key: 'f', code: 'KeyF' })).toBeNull()
    expect(mac({ metaKey: true, shiftKey: true, key: 'f', code: 'KeyF' })).toBeNull()
    expect(mac({ metaKey: true, ctrlKey: true, key: 'f', code: 'KeyF' })).toBeNull()
    expect(mac({ type: 'keyup', metaKey: true, key: 'f', code: 'KeyF' })).toBeNull()
    expect(mac({ key: 'a', code: 'KeyA' })).toBeNull()
  })

  it('steps tabs with ⌥[ and ⌥]', () => {
    expect(mac({ altKey: true, key: '“', code: 'BracketLeft' })).toBe('prev-tab')
    expect(mac({ altKey: true, key: '‘', code: 'BracketRight' })).toBe('next-tab')
    expect(mac({ altKey: true, key: 'b', code: 'KeyB' })).toBeNull()
  })
})

describe('terminalAction elsewhere', () => {
  const pc = (over: Partial<KeyLike>) => terminalAction(key(over), false)

  it('copies, pastes and finds with Ctrl+Shift, keeping Ctrl+C for the shell', () => {
    expect(pc({ ctrlKey: true, shiftKey: true, key: 'C', code: 'KeyC' })).toBe('copy')
    expect(pc({ ctrlKey: true, shiftKey: true, key: 'V', code: 'KeyV' })).toBe('paste')
    expect(pc({ ctrlKey: true, shiftKey: true, key: 'F', code: 'KeyF' })).toBe('find')
    expect(pc({ ctrlKey: true, key: 'c', code: 'KeyC' })).toBeNull()
    expect(pc({ ctrlKey: true, key: 'f', code: 'KeyF' })).toBeNull()
    expect(pc({ ctrlKey: true, shiftKey: true, key: 'A', code: 'KeyA' })).toBeNull()
  })

  it('sizes the font with Ctrl and ignores the Meta key', () => {
    expect(pc({ ctrlKey: true, key: '=', code: 'Equal' })).toBe('font-up')
    expect(pc({ ctrlKey: true, shiftKey: true, key: '+', code: 'Equal' })).toBe('font-up')
    expect(pc({ ctrlKey: true, key: '-', code: 'Minus' })).toBe('font-down')
    expect(pc({ ctrlKey: true, key: '0', code: 'Digit0' })).toBe('font-reset')
    expect(pc({ ctrlKey: true, key: 'a', code: 'KeyA' })).toBeNull()
    expect(pc({ metaKey: true, key: 'f', code: 'KeyF' })).toBeNull()
    expect(pc({ ctrlKey: true, altKey: true, key: 'f', code: 'KeyF' })).toBeNull()
  })
})
