import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { recordTerminalOutput, completeTerminalOutput, recordTerminalReconnect, forgetTerminal } from '../../lib/diagnostics'
import { answerVersionQuery } from '../../lib/xtversion'
import { connectTerminal, type TerminalConnection } from '../../lib/terminal'
import { ctrlChar, InputQueue, parseOsc52 } from '../../lib/terminal-input'
import { terminalTheme } from '../../lib/theme'
import { useTerminalStore } from '../../stores/terminals'

export interface Callbacks {
  onExit: (code: number) => void
  onDisconnect: () => void
}

// Live is one shell's screen and socket. It outlives the view: switching
// tabs, panes or modes moves the same screen instead of reconnecting and
// replaying the whole scrollback. One Live per terminal also means one
// client answering the shell's terminal queries.
export interface Live {
  el: HTMLDivElement
  xterm: XTerm
  fit: FitAddon
  conn: TerminalConnection
  input: InputQueue
  callbacks: Callbacks
  // opened: xterm is attached to el (it waits for the font).
  opened: boolean
  wantFocus: boolean
  size: { cols: number; rows: number } | null
  // ctrl is the sticky Ctrl of the touch key row: the next typed key is
  // sent as its control code.
  ctrl: { release: () => void } | null
  refit: (() => void) | null
  open: () => void
  dispose: () => void
}

export const lives = new Map<string, Live>()

const FONT = '"PT Mono", "SF Mono", ui-monospace, Menlo, monospace'
const FONT_WAIT_MS = 1500
// Every few failed reconnects, check the terminal still exists: one closed
// elsewhere would otherwise be retried for as long as the tab is open.
const RECHECK_EVERY = 5

// A screen goes once its terminal is closed.
useTerminalStore.subscribe((s) => {
  for (const [id, live] of lives) {
    if (!s.terminals.some((t) => t.id === id)) {
      live.dispose()
      lives.delete(id)
    }
  }
})

// fontReady resolves once PT Mono is loaded (or after a short wait): xterm
// measures its cell size when it opens, and a fallback font measured first
// leaves the grid misaligned.
function fontReady(): Promise<void> | null {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined
  if (!fonts?.load) return null
  return Promise.race([
    fonts.load('13px "PT Mono"').then(() => undefined, () => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, FONT_WAIT_MS)),
  ])
}

const stopTyping = (xterm: XTerm) => {
  xterm.options.disableStdin = true
  xterm.options.cursorBlink = false
}

// liveFor returns the screen of a terminal, opening it inside host the
// first time: xterm measures its font against the element it opens in.
export function liveFor(id: string, host: HTMLElement, callbacks: Callbacks): Live {
  const found = lives.get(id)
  if (found) {
    found.callbacks = callbacks
    host.appendChild(found.el)
    if (!found.opened) found.open()
    return found
  }
  const el = document.createElement('div')
  el.className = 'terminal-screen'
  host.appendChild(el)
  const scheme = window.matchMedia('(prefers-color-scheme: dark)')
  const xterm = new XTerm({
    fontFamily: FONT,
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 10000,
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
  xterm.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri, '_blank', 'noopener,noreferrer')))
  xterm.unicode.activeVersion = '11'
  // OSC 52 lets a program (vim, tmux) put text on the clipboard. Reads are
  // refused: output must never be able to pull the clipboard.
  const clipboard = xterm.parser.registerOscHandler(52, (data) => {
    const text = parseOsc52(data)
    if (text !== null) void navigator.clipboard?.writeText(text).catch(() => {})
    return true
  })
  if (useTerminalStore.getState().terminals.find((t) => t.id === id)?.status === 'exited') stopTyping(xterm)

  // Input is held back while the scrollback replays: xterm answers terminal
  // queries found in it, and those answers must not reach the shell again.
  // What the owner types meanwhile is kept and sent once the replay is done.
  let ready = false
  let replayGeneration = 0
  let disposed = false
  const live: Live = {
    el, xterm, fit, callbacks,
    conn: undefined as unknown as TerminalConnection,
    input: new InputQueue((data) => live.conn.send(data)),
    opened: false, wantFocus: false, size: null, ctrl: null, refit: null,
    open: () => {},
    dispose: () => {},
  }
  const openNow = () => {
    if (disposed || live.opened) return
    // A view that went away meanwhile opens it on its next attach.
    if (!el.isConnected) return
    xterm.open(el)
    live.opened = true
    live.refit?.()
    if (live.wantFocus) xterm.focus()
  }
  live.open = openNow
  const fonts = fontReady()
  if (fonts) void fonts.then(openNow)
  else openNow()
  const onFonts = () => live.refit?.()
  document.fonts?.addEventListener?.('loadingdone', onFonts)

  live.conn = connectTerminal(id, {
    onOutput: (data) => {
      const start = performance.now()
      recordTerminalOutput(id, data.byteLength)
      xterm.write(data, () => completeTerminalOutput(id, data.byteLength, performance.now() - start))
    },
    onReady: () => {
      const mine = replayGeneration
      xterm.write('', () => {
        if (mine !== replayGeneration) return
        ready = true
        live.input.setReady(true)
      })
    },
    onReset: (reason) => {
      if (reason !== 'upgrade') recordTerminalReconnect(id)
      ready = false
      live.input.setReady(false)
      const mine = ++replayGeneration
      // reset doesn't discard queued writes: clear the screen after old
      // output is parsed, before the next connection's replay is parsed.
      xterm.write('', () => {
        if (mine === replayGeneration) xterm.reset()
      })
    },
    onExit: (code) => {
      xterm.write(`\r\n[process exited with code ${code}]\r\n`)
      stopTyping(xterm)
      live.input.clear()
      live.callbacks.onExit(code)
    },
    onGiveUp: () => live.callbacks.onDisconnect(),
    onState: (state, attempt) => {
      useTerminalStore.getState().setConnState(id, state, attempt)
      if (state === 'reconnecting' && attempt && attempt % RECHECK_EVERY === 0) live.callbacks.onDisconnect()
    },
  })
  const input = xterm.onData((data) => {
    if (live.ctrl && data.length === 1) {
      const code = ctrlChar(data)
      const { release } = live.ctrl
      live.ctrl = null
      release()
      if (code) data = code
    }
    live.input.push(data)
  })
  const version = answerVersionQuery(xterm, () => ready, (data) => live.conn.send(data))
  live.dispose = () => {
    disposed = true
    forgetTerminal(id)
    scheme.removeEventListener?.('change', onScheme)
    document.fonts?.removeEventListener?.('loadingdone', onFonts)
    input.dispose()
    version.dispose()
    clipboard.dispose()
    live.conn.close()
    xterm.dispose()
    el.remove()
  }
  lives.set(id, live)
  return live
}

// reconnectTerminal tries the terminal's connection again now.
export function reconnectTerminal(id: string): void {
  lives.get(id)?.conn.reconnect()
}

// sendKeys types data into the terminal as if from its keyboard.
export function sendKeys(id: string, data: string): void {
  lives.get(id)?.input.push(data)
}

// pasteInto pastes text into the terminal (bracketed when the shell asks).
export function pasteInto(id: string, text: string): void {
  lives.get(id)?.xterm.paste(text)
}

// focusTerminal gives the terminal keyboard focus.
export function focusTerminal(id: string): void {
  lives.get(id)?.xterm.focus()
}

// setStickyCtrl arms (or disarms) Ctrl for the next key typed into the
// terminal; release runs once it has been used.
export function setStickyCtrl(id: string, on: boolean, release: () => void): void {
  const live = lives.get(id)
  if (live) live.ctrl = on ? { release } : null
}

