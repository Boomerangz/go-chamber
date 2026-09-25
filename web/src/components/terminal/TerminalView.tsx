import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import { connectTerminal } from '../../lib/terminal'

interface Props {
  id: string
  autoFocus: boolean
  onExit: (code: number) => void
  onDisconnect: () => void
}

// TerminalView renders one shell with xterm.js. Remounting (switching tabs,
// reloading the page) reattaches and replays the server-side scrollback.
export default function TerminalView({ id, autoFocus, onExit, onDisconnect }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onExit, onDisconnect })
  useEffect(() => {
    callbacks.current = { onExit, onDisconnect }
  }, [onExit, onDisconnect])

  useEffect(() => {
    const el = host.current!
    const xterm = new XTerm({
      fontFamily: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: {
        background: '#0b0c14',
        foreground: '#e4e6f0',
        cursor: '#a78bfa',
        selectionBackground: 'rgba(139, 92, 246, 0.35)',
      },
    })
    const fit = new FitAddon()
    xterm.loadAddon(fit)
    xterm.open(el)
    // Input is held back while the scrollback replays: xterm answers terminal
    // queries found in it, and those answers must not reach the shell again.
    let live = false
    const conn = connectTerminal(id, {
      onOutput: (data) => xterm.write(data),
      onReady: () => xterm.write('', () => (live = true)),
      onReset: () => {
        live = false
        xterm.reset()
      },
      onExit: (code) => {
        xterm.write(`\r\n[process exited with code ${code}]\r\n`)
        callbacks.current.onExit(code)
      },
      onGiveUp: () => {
        xterm.write('\r\n[disconnected]\r\n')
        callbacks.current.onDisconnect()
      },
    })
    const input = xterm.onData((data) => {
      if (live) conn.send(data)
    })
    const resize = () => {
      if (el.clientWidth === 0) return
      fit.fit()
      conn.resize(xterm.cols, xterm.rows)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(el)
    resize()
    if (autoFocus) xterm.focus()
    return () => {
      observer.disconnect()
      input.dispose()
      conn.close()
      xterm.dispose()
    }
    // autoFocus only matters on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  return <div className="terminal-view" ref={host} data-testid="terminal-view" />
}
