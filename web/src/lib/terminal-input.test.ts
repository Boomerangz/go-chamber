import { describe, expect, it } from 'vitest'
import { ctrlChar, InputQueue, keySequence, parseOsc52, stripTerminalReplies } from './terminal-input'

describe('stripTerminalReplies', () => {
  it('drops cursor position and device attribute reports', () => {
    expect(stripTerminalReplies('\x1b[12;40R')).toBe('')
    expect(stripTerminalReplies('\x1b[?1;2c')).toBe('')
    expect(stripTerminalReplies('\x1b[>0;276;0c')).toBe('')
    expect(stripTerminalReplies('\x1b[?2026;2$y')).toBe('')
    expect(stripTerminalReplies('\x1b]11;rgb:0f0f/1010/1212\x1b\\')).toBe('')
  })

  it('keeps what the owner typed around replies', () => {
    expect(stripTerminalReplies('ls\x1b[1;1R -la\r')).toBe('ls -la\r')
    expect(stripTerminalReplies('\x1b[A')).toBe('\x1b[A')
    expect(stripTerminalReplies('\x1b[3~')).toBe('\x1b[3~')
    expect(stripTerminalReplies('c')).toBe('c')
  })
})

// link is a connection that only takes input while open, recording what
// reached the shell.
function link(open = false) {
  const l = {
    open,
    sent: [] as string[],
    send: (data: string) => {
      if (!l.open) return false
      l.sent.push(data)
      return true
    },
  }
  return l
}

describe('InputQueue', () => {
  it('sends straight through while ready', () => {
    const l = link(true)
    const q = new InputQueue(l.send)
    q.setReady(true)
    q.push('a')
    expect(l.sent).toEqual(['a'])
  })

  it('holds typing while not connected and flushes it in order, without replies', () => {
    const l = link()
    const q = new InputQueue(l.send)
    q.push('ec')
    q.push('\x1b[5;1R')
    q.push('ho\r')
    expect(l.sent).toEqual([])
    l.open = true
    q.setReady(true)
    expect(l.sent).toEqual(['echo\r'])
    q.setReady(false)
    q.push('\x1b[?1;2c')
    q.setReady(true)
    expect(l.sent).toEqual(['echo\r'])
  })

  // Typing must not wait for a replay (or a flood of output) to finish:
  // Ctrl-C has to reach a shell that floods the screen.
  it('sends typing at once while replaying when the connection takes it', () => {
    const l = link(true)
    const q = new InputQueue(l.send)
    q.push('\x03')
    q.push('\x1b[5;1R')
    expect(l.sent).toEqual(['\x03'])
  })

  it('keeps order: once something is held, later typing waits behind it', () => {
    const l = link()
    const q = new InputQueue(l.send)
    q.push('a')
    l.open = true
    q.push('b')
    expect(l.sent).toEqual([])
    q.setReady(true)
    expect(l.sent).toEqual(['ab'])
  })

  it('caps what it holds', () => {
    const l = link()
    const q = new InputQueue(l.send, 4)
    q.push('abc')
    q.push('def')
    l.open = true
    q.setReady(true)
    expect(l.sent).toEqual(['cdef'])
  })

  it('forgets held input when cleared', () => {
    const l = link()
    const q = new InputQueue(l.send)
    q.push('x')
    q.clear()
    l.open = true
    q.setReady(true)
    expect(l.sent).toEqual([])
  })
})

describe('ctrlChar', () => {
  it('maps letters and symbols to control codes', () => {
    expect(ctrlChar('c')).toBe('\x03')
    expect(ctrlChar('C')).toBe('\x03')
    expect(ctrlChar('[')).toBe('\x1b')
    expect(ctrlChar(' ')).toBe('\x00')
    expect(ctrlChar('?')).toBe('\x7f')
    expect(ctrlChar('1')).toBeNull()
    expect(ctrlChar('ab')).toBeNull()
  })
})

describe('keySequence', () => {
  it('names the special keys of the mobile row', () => {
    expect(keySequence('esc')).toBe('\x1b')
    expect(keySequence('tab')).toBe('\t')
    expect(keySequence('up')).toBe('\x1b[A')
    expect(keySequence('down')).toBe('\x1b[B')
    expect(keySequence('right')).toBe('\x1b[C')
    expect(keySequence('left')).toBe('\x1b[D')
    expect(keySequence('interrupt')).toBe('\x03')
  })
})

describe('parseOsc52', () => {
  it('decodes a clipboard write', () => {
    expect(parseOsc52('c;' + btoa('hello'))).toBe('hello')
    expect(parseOsc52(';' + btoa(String.fromCharCode(...new TextEncoder().encode('привет'))))).toBe('привет')
  })

  it('ignores clipboard reads and garbage', () => {
    expect(parseOsc52('c;?')).toBeNull()
    expect(parseOsc52('nope')).toBeNull()
    expect(parseOsc52('c;***')).toBeNull()
  })
})
