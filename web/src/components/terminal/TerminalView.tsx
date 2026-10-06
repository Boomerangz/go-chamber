import { useEffect, useRef } from 'react'
import { useTerminalStore } from '../../stores/terminals'
import { lives, liveFor, type Callbacks } from './live'

interface Props {
  id: string
  autoFocus: boolean
  // focusKey changes each time the owner picks this terminal again.
  focusKey?: number
  onExit: (code: number) => void
  onDisconnect: () => void
}

// TerminalView shows one shell with xterm.js.
export default function TerminalView({ id, autoFocus, focusKey = 0, onExit, onDisconnect }: Props) {
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
    // A connection that gave up while hidden tries again when shown.
    if (useTerminalStore.getState().conn[id]?.state === 'disconnected') live.conn.reconnect()
    const resize = () => {
      if (!live.opened || el.clientWidth === 0) return
      live.fit.fit()
      const { cols, rows } = live.xterm
      if (live.size?.cols === cols && live.size?.rows === rows) return
      live.size = { cols, rows }
      live.conn.resize(cols, rows)
    }
    // Layout changes come in bursts (a dragged divider, the keyboard
    // sliding in): fit once per frame.
    let frame = 0
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        resize()
      })
    }
    live.refit = resize
    const observer = new ResizeObserver(schedule)
    observer.observe(el)
    resize()
    return () => {
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
      if (live.refit === resize) live.refit = null
      // Another view of the same terminal may have taken the screen already.
      if (live.el.parentElement === el) live.el.remove()
    }
  }, [id])

  useEffect(() => {
    const live = lives.get(id)
    if (!autoFocus || !live) return
    if (live.opened) live.xterm.focus()
    else live.wantFocus = true
  }, [id, autoFocus, focusKey])

  return <div className="terminal-view" ref={host} data-testid="terminal-view" />
}
