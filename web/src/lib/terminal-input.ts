// Terminal input helpers: what xterm.js sends on its own, what the owner
// typed, and the keys a phone keyboard lacks.

// Replies xterm.js writes to answer terminal queries found in the output:
// cursor position (CSI n;n R), primary and secondary device attributes
// (CSI ? … c, CSI > … c), mode reports (CSI ? … $ y) and colour reports
// (OSC 10–19). Replayed scrollback can hold old queries; their answers must
// not reach the shell again.
// eslint-disable-next-line no-control-regex -- terminal replies are control sequences
const REPLIES = /\x1b\[\??\d+;\d+R|\x1b\[[?>][\d;]*c|\x1b\[\??[\d;]*\$y|\x1b\]1\d;[^\x07\x1b]*(?:\x07|\x1b\\)/g

export function stripTerminalReplies(data: string): string {
  return data.replace(REPLIES, '')
}

// InputQueue holds what the owner types while the connection is not ready
// (connecting, reconnecting, switching transport) and sends it, in order,
// once it is. Automatic replies are dropped from what is held.
export class InputQueue {
  private held = ''
  private ready = false
  private readonly send: (data: string) => void
  private readonly max: number

  constructor(send: (data: string) => void, max = 4096) {
    this.send = send
    this.max = max
  }

  push(data: string): void {
    if (this.ready) {
      this.send(data)
      return
    }
    const typed = stripTerminalReplies(data)
    if (!typed) return
    this.held = (this.held + typed).slice(-this.max)
  }

  setReady(ready: boolean): void {
    this.ready = ready
    if (ready && this.held) {
      const held = this.held
      this.held = ''
      this.send(held)
    }
  }

  clear(): void {
    this.held = ''
  }
}

// ctrlChar is the control code a Ctrl chord sends with ch, or null when the
// chord has none.
export function ctrlChar(ch: string): string | null {
  if (ch.length !== 1) return null
  if (ch === ' ') return '\x00'
  if (ch === '?') return '\x7f'
  const code = ch.toUpperCase().charCodeAt(0)
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code & 0x1f)
  return null
}

export type SpecialKey = 'esc' | 'tab' | 'up' | 'down' | 'left' | 'right' | 'interrupt' | 'eof' | 'home' | 'end' | 'pgup' | 'pgdn'

const KEYS: Record<SpecialKey, string> = {
  esc: '\x1b',
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  interrupt: '\x03',
  eof: '\x04',
  home: '\x1b[H',
  end: '\x1b[F',
  pgup: '\x1b[5~',
  pgdn: '\x1b[6~',
}

export function keySequence(key: SpecialKey): string {
  return KEYS[key]
}

// parseOsc52 decodes the text of an OSC 52 clipboard write ("c;<base64>").
// Reads ("?") are refused: output must never be able to pull the clipboard.
export function parseOsc52(data: string): string | null {
  const sep = data.indexOf(';')
  if (sep < 0) return null
  const payload = data.slice(sep + 1)
  if (!payload || payload === '?') return null
  try {
    const binary = atob(payload)
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
  } catch {
    return null
  }
}
