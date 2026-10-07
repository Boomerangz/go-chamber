import { describe, expect, it } from 'vitest'
import { formatCombo, isStrayFocus, isTypingTarget, matches, nextIndex, notePointer } from './hotkeys'

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

describe('isStrayFocus', () => {
  const el = (html: string, pick = '[data-t]') => {
    const root = document.createElement('div')
    root.innerHTML = html
    document.body.append(root)
    return root.querySelector<HTMLElement>(pick)!
  }
  const clicked = (e: HTMLElement) => {
    notePointer(e)
    return isStrayFocus(e)
  }

  it('is a control left focused by a click: a rail button, a tab, a link', () => {
    expect(clicked(el('<nav><button data-t>Terminal</button></nav>'))).toBe(true)
    expect(clicked(el('<div role="tab" tabindex="0" data-t><span>x</span></div>'))).toBe(true)
    expect(clicked(el('<a href="#" data-t><span>more</span></a>'))).toBe(true)
    const inner = el('<button><span data-t>inner</span></button>')
    expect(clicked(inner)).toBe(true)
  })

  it('leaves the keys to the page, a session row and a request', () => {
    notePointer(document.body)
    expect(isStrayFocus(document.body)).toBe(false)
    expect(isStrayFocus(null)).toBe(false)
    expect(clicked(el('<div data-t>text</div>'))).toBe(false)
    expect(clicked(el('<aside class="sidebar"><button class="session" data-t>alpha</button></aside>'))).toBe(false)
    expect(clicked(el('<div class="request"><button data-t>Allow</button></div>'))).toBe(false)
  })

  it('leaves the keys to a control reached by the keyboard', () => {
    const one = el('<button data-t>One</button>')
    notePointer(el('<button data-t>Two</button>'))
    expect(isStrayFocus(one)).toBe(false)
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
    expect(formatCombo({ key: 'n' }, true)).toBe('n')
    expect(formatCombo({ key: 'n' }, false)).toBe('n')
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

describe('matches, modifiers in detail', () => {
  it('rejects the other platform modifier', () => {
    expect(matches(key('k', { ctrlKey: true, metaKey: true }), { key: 'k', mod: true }, false)).toBe(false)
    expect(matches(key('j', { ctrlKey: true }), { key: 'j' }, true)).toBe(false)
  })

  it('needs Shift exactly when the combo asks for it', () => {
    expect(matches(key('J', { shiftKey: true }), { key: 'j' }, true)).toBe(false)
    expect(matches(key('J', { shiftKey: true }), { key: 'j', shift: true }, true)).toBe(true)
    expect(matches(key('j'), { key: 'j', shift: true }, true)).toBe(false)
  })

  it('needs Alt exactly when the combo asks for it', () => {
    expect(matches(key('ArrowDown', { altKey: true }), { key: 'ArrowDown', alt: true }, true)).toBe(true)
    expect(matches(key('ArrowDown'), { key: 'ArrowDown', alt: true }, true)).toBe(false)
  })

  it('does not match a different key', () => {
    expect(matches(key('j'), { key: 'k' }, true)).toBe(false)
  })
})

describe('isTypingTarget, input kinds', () => {
  it('counts text-like inputs and selects, not toggles and buttons', () => {
    const make = (type: string) => Object.assign(document.createElement('input'), { type })
    expect(isTypingTarget(make('search'))).toBe(true)
    expect(isTypingTarget(make('text'))).toBe(true)
    for (const type of ['radio', 'button', 'submit', 'reset', 'range', 'color', 'file']) {
      expect(isTypingTarget(make(type))).toBe(false)
    }
    expect(isTypingTarget(document.createElement('select'))).toBe(true)
    expect(isTypingTarget(document.createElement('div'))).toBe(false)
  })
})

describe('formatCombo, every modifier', () => {
  it('joins with + off the Mac and runs together on it', () => {
    expect(formatCombo({ key: 'k', mod: true, shift: true }, false)).toBe('Ctrl+Shift+K')
    expect(formatCombo({ key: 'k', mod: true, shift: true }, true)).toBe('⌘⇧K')
    expect(formatCombo({ key: 'ArrowDown', alt: true }, false)).toBe('Alt+↓')
    expect(formatCombo({ key: 'Enter', mod: true }, true)).toBe('⌘↵')
    expect(formatCombo({ key: 'Escape' }, false)).toBe('Esc')
    expect(formatCombo({ key: 'Tab' }, false)).toBe('Tab')
    expect(formatCombo({ key: 'ArrowUp' }, true)).toBe('↑')
    expect(formatCombo({ key: 'ArrowLeft' }, true)).toBe('←')
    expect(formatCombo({ key: 'ArrowRight' }, true)).toBe('→')
  })
})
