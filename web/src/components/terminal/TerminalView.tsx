import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import { recordTerminalOutput, completeTerminalOutput, recordTerminalReconnect, forgetTerminal } from '../../lib/diagnostics'
import { answerVersionQuery } from '../../lib/xtversion'
import { connectTerminal, type TerminalConnection } from '../../lib/terminal'
import { terminalTheme } from '../../lib/theme'
import { useTerminalStore } from '../../stores/terminals'

interface Props {
  id: string
  autoFocus: boolean
  onExit: (code: number) => void
  onDisconnect: () => void
}

interface Callbacks {
  onExit: (code: number) => void
  onDisconnect: () => void
}

// Live is one shell's screen and socket. It outlives the view: switching
// tabs, panes or modes moves the same screen instead of reconnecting and
// replaying the whole scrollback. One Live per terminal also means one
// client answering the shell's terminal queries.
interface Live {
  el: HTMLDivElement
  xterm: XTerm
  fit: FitAddon
  conn: TerminalConnection
  callbacks: Callbacks
  dispose: () => void
}

const lives = new Map<string, Live>()

// A screen goes once its terminal is closed.
useTerminalStore.subscribe((s) => {
  for (const [id, live] of lives) {
    if (!s.terminals.some((t) => t.id === id)) {
      live.dispose()
      lives.delete(id)
    }
  }
})

// liveFor returns the screen of a terminal, opening it inside host the
// first time: xterm measures its font against the element it opens in.
function liveFor(id: string, host: HTMLElement, callbacks: Callbacks): Live {
  const found = lives.get(id)
  if (found) {
    found.callbacks = callbacks
    host.appendChild(found.el)
    return found
  }
  const el = document.createElement('div')
  el.className = 'terminal-screen'
  host.appendChild(el)
  const scheme = window.matchMedia('(prefers-color-scheme: dark)')
  const xterm = new XTerm({
    fontFamily: '"PT Mono", "SF Mono", ui-monospace, Menlo, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    // Unicode 11 widths match what TUIs like Claude Code assume for emoji,
    // so their cursor moves land where they expect.
    allowProposedApi: true,
    theme: terminalTheme(scheme.matches),
  })
  const onScheme = () => (xterm.options.theme = terminalTheme(scheme.matches))
  scheme.addEventListener?.('change', onScheme)
  const fit = new FitAddon()
  xterm.loadAddon(fit)
  xterm.loadAddon(new Unicode11Addon())
  xterm.unicode.activeVersion = '11'
  xterm.open(el)
  // Input is held back while the scrollback replays: xterm answers terminal
  // queries found in it, and those answers must not reach the shell again.
  let ready = false
  const live: Live = { el, xterm, fit, callbacks, conn: undefined as unknown as TerminalConnection, dispose: () => {} }
  live.conn = connectTerminal(id, {
    onOutput: (data) => {
      const start = performance.now()
      recordTerminalOutput(id, data.byteLength)
      xterm.write(data, () => completeTerminalOutput(id, data.byteLength, performance.now() - start))
    },
    onReady: () => xterm.write('', () => (ready = true)),
    onReset: () => {
      recordTerminalReconnect(id)
      ready = false
      xterm.reset()
    },
    onExit: (code) => {
      xterm.write(`\r\n[process exited with code ${code}]\r\n`)
      live.callbacks.onExit(code)
    },
    onGiveUp: () => {
      xterm.write('\r\n[disconnected]\r\n')
      live.callbacks.onDisconnect()
    },
  })
  const input = xterm.onData((data) => {
    if (ready) live.conn.send(data)
  })
  const version = answerVersionQuery(xterm, () => ready, (data) => live.conn.send(data))
  live.dispose = () => {
    forgetTerminal(id)
    scheme.removeEventListener?.('change', onScheme)
    input.dispose()
    version.dispose()
    live.conn.close()
    xterm.dispose()
    el.remove()
  }
  lives.set(id, live)
  return live
}

// TerminalView shows one shell with xterm.js.
export default function TerminalView({ id, autoFocus, onExit, onDisconnect }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const callbacks = useRef<Callbacks>({ onExit, onDisconnect })
  useEffect(() => {
    callbacks.current.onExit = onExit
    callbacks.current.onDisconnect = onDisconnect
  }, [onExit, onDisconnect])

  useEffect(() => {
    const el = host.current!
    const live = liveFor(id, el, {
      onExit: (code) => callbacks.current.onExit(code),
      onDisconnect: () => callbacks.current.onDisconnect(),
    })
    const resize = () => {
      if (el.clientWidth === 0) return
      live.fit.fit()
      live.conn.resize(live.xterm.cols, live.xterm.rows)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(el)
    resize()
    if (autoFocus) live.xterm.focus()
    return () => {
      observer.disconnect()
      // Another view of the same terminal may have taken the screen already.
      if (live.el.parentElement === el) live.el.remove()
    }
    // autoFocus only matters on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  return <div className="terminal-view" ref={host} data-testid="terminal-view" />
}
