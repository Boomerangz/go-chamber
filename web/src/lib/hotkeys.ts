// Keyboard shortcuts: a combo is a key plus modifiers; `mod` is ⌘ on Macs and
// Ctrl elsewhere. Plain-key shortcuts never fire while the owner types.

export interface Combo {
  key: string
  mod?: boolean
  alt?: boolean
  shift?: boolean
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

// Keys whose character already implies Shift; their Shift state is ignored.
const shifted = new Set(['?', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '+', '{', '}', '|', ':', '"', '<', '>', '~'])

export function matches(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, combo: Combo, mac = isMac): boolean {
  if (e.key.toLowerCase() !== combo.key.toLowerCase()) return false
  const mod = mac ? e.metaKey : e.ctrlKey
  const other = mac ? e.ctrlKey : e.metaKey
  if (mod !== Boolean(combo.mod) || other) return false
  if (e.altKey !== Boolean(combo.alt)) return false
  if (!shifted.has(combo.key) && e.shiftKey !== Boolean(combo.shift)) return false
  return true
}

// isTypingTarget is true for anything that takes text, the terminal included.
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('.xterm')) return true
  if (target.isContentEditable || target.contentEditable === 'true') return true
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
  if (target instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(target.type)
  }
  return false
}

const glyphs: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: '↵', Escape: 'Esc' }

export function formatCombo(combo: Combo, mac = isMac): string {
  const key = glyphs[combo.key] ?? (combo.key.length === 1 ? combo.key.toUpperCase() : combo.key)
  const parts: string[] = []
  if (combo.mod) parts.push(mac ? '⌘' : 'Ctrl')
  if (combo.alt) parts.push(mac ? '⌥' : 'Alt')
  if (combo.shift) parts.push(mac ? '⇧' : 'Shift')
  return mac ? parts.join('') + key : [...parts, key].join('+')
}

// nextIndex moves through a list by step, staying in bounds; with nothing
// current it starts at the end you are heading from.
export function nextIndex(current: number, length: number, step: 1 | -1): number {
  if (length === 0) return -1
  if (current < 0) return step > 0 ? 0 : length - 1
  return Math.min(length - 1, Math.max(0, current + step))
}
