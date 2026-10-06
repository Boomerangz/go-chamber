import { describe, expect, it } from 'vitest'
import { formatCombo, isTypingTarget, matches, nextIndex } from './hotkeys'

const key = (k: string, mods: Partial<KeyboardEvent> = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent

describe('matches', () => {
  it('needs the platform modifier when the combo has one', () => {
    expect(matches(key('k', { metaKey: true }), { key: 'k', mod: true }, true)).toBe(true)
    expect(matches(key('k', { ctrlKey: true }), { key: 'k', mod: true }, false)).toBe(true)
    expect(matches(key('k', { ctrlKey: true }), { key: 'k', mod: true }, true)).toBe(false)
    expect(matches(key('k'), { key: 'k', mod: true }, true)).toBe(false)
  })

  it('rejects extra modifiers on plain keys', () => {
    expect(matches(key('j'), { key: 'j' }, true)).toBe(true)
    expect(matches(key('j', { metaKey: true }), { key: 'j' }, true)).toBe(false)
    expect(matches(key('j', { altKey: true }), { key: 'j' }, true)).toBe(false)
  })

  it('treats ? as itself whatever shift produced it', () => {
    expect(matches(key('?', { shiftKey: true }), { key: '?' }, true)).toBe(true)
  })

  it('is case-insensitive for letters', () => {
    expect(matches(key('K', { metaKey: true, shiftKey: false }), { key: 'k', mod: true }, true)).toBe(true)
  })
})

describe('isTypingTarget', () => {
  it('spots fields, editable text and the terminal', () => {
    const input = document.createElement('input')
    const area = document.createElement('textarea')
    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    const term = document.createElement('div')
    term.className = 'xterm'
    const inner = document.createElement('span')
    term.appendChild(inner)
    const plain = document.createElement('button')
    const box = document.createElement('input')
    box.type = 'checkbox'
    expect(isTypingTarget(input)).toBe(true)
    expect(isTypingTarget(area)).toBe(true)
    expect(isTypingTarget(editable)).toBe(true)
    expect(isTypingTarget(inner)).toBe(true)
    expect(isTypingTarget(plain)).toBe(false)
    expect(isTypingTarget(box)).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('formatCombo', () => {
  it('prints the platform modifier', () => {
    expect(formatCombo({ key: 'k', mod: true }, true)).toBe('⌘K')
    expect(formatCombo({ key: 'k', mod: true }, false)).toBe('Ctrl+K')
    expect(formatCombo({ key: '?' }, true)).toBe('?')
    expect(formatCombo({ key: 'ArrowDown', alt: true }, true)).toBe('⌥↓')
  })
})

describe('nextIndex', () => {
  it('steps and clamps; starts at the edge when nothing is current', () => {
    expect(nextIndex(-1, 3, 1)).toBe(0)
    expect(nextIndex(-1, 3, -1)).toBe(2)
    expect(nextIndex(1, 3, 1)).toBe(2)
    expect(nextIndex(2, 3, 1)).toBe(2)
    expect(nextIndex(0, 3, -1)).toBe(0)
    expect(nextIndex(0, 0, 1)).toBe(-1)
  })
})
