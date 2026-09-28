import { Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { answerVersionQuery } from './xtversion'

const write = (term: Terminal, data: string) => new Promise<void>((r) => term.write(data, r))

describe('answerVersionQuery', () => {
  it('names the terminal when asked with XTVERSION', async () => {
    const term = new Terminal({ allowProposedApi: true })
    const send = vi.fn()
    answerVersionQuery(term, () => true, send)
    await write(term, '\x1b[>q')
    await write(term, '\x1b[>0q')
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledWith('\x1bP>|xterm.js(6.0.0)\x1b\\')
  })

  it('stays silent while the scrollback replays and for other > queries', async () => {
    const term = new Terminal({ allowProposedApi: true })
    const send = vi.fn()
    let live = false
    answerVersionQuery(term, () => live, send)
    await write(term, '\x1b[>q')
    live = true
    await write(term, '\x1b[>1q')
    expect(send).not.toHaveBeenCalled()
  })
})
