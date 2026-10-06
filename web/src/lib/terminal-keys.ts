// Keys the terminal takes for itself before xterm.js sees them: find, copy
// and paste where the platform's terminals put them, font size, and
// stepping between terminal tabs.

export type TerminalAction = 'find' | 'copy' | 'paste' | 'font-up' | 'font-down' | 'font-reset' | 'prev-tab' | 'next-tab'

export type KeyLike = Pick<KeyboardEvent, 'type' | 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

const font = (e: KeyLike): TerminalAction | null => {
  if (e.code === 'Equal' || e.key === '=' || e.key === '+') return 'font-up'
  if (e.code === 'Minus' || e.key === '-') return 'font-down'
  if (e.code === 'Digit0' || e.key === '0') return 'font-reset'
  return null
}

// terminalAction is what a key press in the terminal asks for, or null to
// leave it to the shell. On a Mac ⌘ carries the commands (⌘C and ⌘V stay
// the browser's); elsewhere Ctrl+Shift does, so Ctrl+C still interrupts.
export function terminalAction(e: KeyLike, mac: boolean): TerminalAction | null {
  if (e.type !== 'keydown') return null
  if (e.altKey && !e.metaKey && !e.ctrlKey) {
    if (e.code === 'BracketLeft') return 'prev-tab'
    if (e.code === 'BracketRight') return 'next-tab'
    return null
  }
  if (mac) {
    if (!e.metaKey || e.ctrlKey || e.altKey) return null
    if (e.code === 'KeyF' || e.key.toLowerCase() === 'f') return e.shiftKey ? null : 'find'
    return font(e)
  }
  if (!e.ctrlKey || e.metaKey || e.altKey) return null
  if (e.shiftKey) {
    if (e.code === 'KeyF') return 'find'
    if (e.code === 'KeyC') return 'copy'
    if (e.code === 'KeyV') return 'paste'
    return e.code === 'Equal' ? 'font-up' : null
  }
  return font(e)
}
