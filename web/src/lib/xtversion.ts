import type { Terminal } from '@xterm/xterm'

// answerVersionQuery replies to XTVERSION (CSI > q), which xterm.js leaves
// unanswered. TUIs such as Claude Code only ask about synchronized output
// (DEC 2026, which xterm.js supports) once the terminal has named itself;
// without it they repaint without frames and redraws take seconds.
export function answerVersionQuery(term: Terminal, live: () => boolean, send: (data: string) => void) {
  return term.parser.registerCsiHandler({ prefix: '>', final: 'q' }, (params) => {
    if ((params[0] ?? 0) !== 0) return false
    if (live()) send('\x1bP>|xterm.js(6.0.0)\x1b\\')
    return true
  })
}
