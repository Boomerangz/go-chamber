// Keys the terminal takes for itself before xterm.js sees them: find, copy
// and paste where the platform's terminals put them, font size, stepping
// between terminal tabs, the way out, and the app's own ⌘K and ⌘B.
//
// The way out is ⌘↑ on a Mac and Ctrl+Shift+↑ elsewhere: a shell never gets
// ⌘ on a Mac, and Ctrl+Shift is where the other terminal commands live
// elsewhere. Esc and Tab stay the shell's (vi mode, completion), and
// Ctrl+Esc is the Start menu on Windows.

export type TerminalAction = 'find' | 'copy' | 'paste' | 'font-up' | 'font-down' | 'font-reset' | 'prev-tab' | 'next-tab' | 'leave' | 'app'

export type KeyLike = Pick<KeyboardEvent, 'type' | 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

const font = (e: KeyLike): TerminalAction | null => {
  if (e.code === 'Equal' || e.key === '=' || e.key === '+') return 'font-up'
  if (e.code === 'Minus' || e.key === '-') return 'font-down'
  if (e.code === 'Digit0' || e.key === '0') return 'font-reset'
  return null
}

// terminalAction is what a key press in the terminal asks for, or null to
// leave it to the shell. On a Mac ⌘ carries the commands (⌘C and ⌘V stay
// the browser's); elsewhere Ctrl+Shift does, so Ctrl+C still interrupts,
// and Ctrl+K and Ctrl+B stay readline's. 'app' passes the key on to the
// app's shortcuts without xterm acting on it.
export function terminalAction(e: KeyLike, mac: boolean): TerminalAction | null {
  if (e.type !== 'keydown') return null
  if (e.altKey && !e.metaKey && !e.ctrlKey) {
    if (e.code === 'BracketLeft') return 'prev-tab'
    if (e.code === 'BracketRight') return 'next-tab'
    return null
  }
  if (mac) {
    if (!e.metaKey || e.ctrlKey || e.altKey) return null
    if (e.key === 'ArrowUp') return e.shiftKey ? null : 'leave'
    if (e.code === 'KeyF' || e.key.toLowerCase() === 'f') return e.shiftKey ? null : 'find'
    if (!e.shiftKey && (e.code === 'KeyK' || e.code === 'KeyB')) return 'app'
    return font(e)
  }
  if (!e.ctrlKey || e.metaKey || e.altKey) return null
  if (e.shiftKey) {
    if (e.key === 'ArrowUp') return 'leave'
    if (e.code === 'KeyF') return 'find'
    if (e.code === 'KeyC') return 'copy'
    if (e.code === 'KeyV') return 'paste'
    return e.code === 'Equal' ? 'font-up' : null
  }
  return font(e)
}

// terminalShortcuts lists the keys above for the shortcut help.
export function terminalShortcuts(mac: boolean): { keys: string; label: string }[] {
  const k = (key: string, shift = false) => (mac ? `⌘${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`)
  const alt = mac ? '⌥' : 'Alt+'
  return [
    { keys: k('F', true), label: 'In a terminal: find in the scrollback' },
    { keys: `${k('=')} · ${k('-')} · ${k('0')}`, label: 'In a terminal: larger, smaller, default text' },
    { keys: `${k('C', true)} · ${k('V', true)}`, label: 'In a terminal: copy the selection, paste' },
    { keys: `${alt}[ · ${alt}]`, label: 'In a terminal: previous, next terminal' },
    { keys: mac ? '⌘↑' : 'Ctrl+Shift+↑', label: 'In a terminal: back to the composer' },
  ]
}
