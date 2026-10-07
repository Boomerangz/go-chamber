import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectTerminal } from '../../lib/terminal'
import { diagnostics, resetDiagnostics } from '../../lib/diagnostics'
import { resetTerminals, useTerminalStore } from '../../stores/terminals'
import { WebLinksAddon } from '@xterm/addon-web-links'
import * as addonSearch from '@xterm/addon-search'
import TerminalView from './TerminalView'
import { endFind, findInTerminal, onFindResults, scrollToBottom, sendKeys, setStickyCtrl } from './live'
import { STEP_EVENT } from './steps'

vi.mock('../../lib/hotkeys', async (original) => ({ ...(await original<typeof import('../../lib/hotkeys')>()), isMac: false }))

const xterms: {
  dispose: ReturnType<typeof vi.fn>
  open: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  reset: ReturnType<typeof vi.fn>
  onData: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  cols: number
  options: Record<string, unknown>
  parser: { registerCsiHandler: ReturnType<typeof vi.fn>; registerOscHandler: ReturnType<typeof vi.fn> }
}[] = []
vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(function (this: Record<string, unknown>, options: Record<string, unknown>) {
    const t = {
      cols: 80,
      rows: 24,
      options: { ...options },
      unicode: { activeVersion: '6' },
      loadAddon: vi.fn(),
      open: vi.fn((el: HTMLElement) => el.appendChild(document.createElement('canvas'))),
      write: vi.fn(),
      reset: vi.fn(),
      focus: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      parser: {
        registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })),
        registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })),
      },
      paste: vi.fn(),
      dispose: vi.fn(),
      attachCustomKeyEventHandler: vi.fn(),
      onScroll: vi.fn(() => ({ dispose: vi.fn() })),
      buffer: { active: { viewportY: 0, baseY: 0 } },
      scrollToBottom: vi.fn(),
      getSelection: vi.fn(() => ''),
      clearSelection: vi.fn(),
    }
    xterms.push(t)
    return t
  }),
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(function () { return { fit: vi.fn() } }) }))
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn(function () {
    return { findNext: vi.fn(() => true), findPrevious: vi.fn(() => false), clearDecorations: vi.fn(), onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })) }
  }),
}))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: vi.fn(function () { return {} }) }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn(function (handler: unknown) { return { handler } }) }))
vi.mock('../../lib/terminal', () => ({
  connectTerminal: vi.fn(() => ({ send: vi.fn(), resize: vi.fn(), close: vi.fn(), reconnect: vi.fn() })),
}))
type Conn = { send: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; reconnect: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
const conn = (i = 0) => vi.mocked(connectTerminal).mock.results[i].value as Conn
const handlers = (i = 0) => vi.mocked(connectTerminal).mock.calls[i][1]

const shell = (id: string) => ({ id, cwd: '/', shell: 'sh', title: id, status: 'running' as const, exitCode: 0, createdAt: '' })
const props = { autoFocus: false, focusKey: 0, onExit: () => {}, onDisconnect: () => {} }

describe('TerminalView', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    xterms.length = 0
    vi.mocked(connectTerminal).mockClear()
    resetTerminals()
    resetDiagnostics()
    useTerminalStore.setState({ terminals: [shell('t1')] })
  })
  afterEach(() => {
    useTerminalStore.setState({ terminals: [] })
    vi.unstubAllGlobals()
  })

  it('keeps the shell attached when the view is unmounted and shown again', () => {
    const first = render(<TerminalView id="t1" {...props} />)
    first.unmount()
    const again = render(<TerminalView id="t1" {...props} />)
    expect(connectTerminal).toHaveBeenCalledTimes(1)
    expect(xterms).toHaveLength(1)
    expect(again.getByTestId('terminal-view').querySelector('canvas')).not.toBeNull()
  })

  it('lets go of the shell once the terminal is gone', () => {
    render(<TerminalView id="t1" {...props} />).unmount()
    const conn = vi.mocked(connectTerminal).mock.results[0].value as { close: ReturnType<typeof vi.fn> }
    useTerminalStore.setState({ terminals: [] })
    expect(conn.close).toHaveBeenCalled()
    expect(xterms[0].dispose).toHaveBeenCalled()
  })

  it('accounts for output until xterm acknowledges processing', () => {
    render(<TerminalView id="t1" {...props} />)
    const callbacks = vi.mocked(connectTerminal).mock.calls[0][1]
    callbacks.onOutput(new Uint8Array([1, 2, 3]))
    expect(diagnostics().terminals[0]?.pendingBytes).toBe(3)
    const acknowledge = xterms[0].write.mock.calls.at(-1)![1] as () => void
    acknowledge()
    expect(diagnostics().terminals[0]?.pendingBytes).toBe(0)
    expect(diagnostics().metrics.terminalParse.count).toBe(1)
    callbacks.onReset?.()
    expect(diagnostics().terminals[0]?.reconnects).toBe(1)
    useTerminalStore.setState({ terminals: [] })
    expect(diagnostics().terminals).toHaveLength(0)
  })

  it('queues reset after old output and ignores the old replay readiness callback', () => {
    render(<TerminalView id="t1" {...props} />)
    const callbacks = vi.mocked(connectTerminal).mock.calls[0][1]
    const conn = vi.mocked(connectTerminal).mock.results[0].value as { send: ReturnType<typeof vi.fn> }
    const xterm = xterms[0]
    const input = xterm.onData.mock.calls[0][0] as (data: string) => void
    callbacks.onOutput(new Uint8Array([1]))
    callbacks.onReady?.()
    const oldReady = xterm.write.mock.calls.at(-1)![1] as () => void
    callbacks.onReset?.('upgrade')
    expect(xterm.reset).not.toHaveBeenCalled()
    const reset = xterm.write.mock.calls.at(-1)![1] as () => void
    oldReady()
    input('\x1b[1;11R')
    expect(conn.send).not.toHaveBeenCalled()
    reset()
    expect(xterm.reset).toHaveBeenCalledTimes(1)
    callbacks.onOutput(new Uint8Array([2]))
    callbacks.onReady?.()
    const newReady = xterm.write.mock.calls.at(-1)![1] as () => void
    input('\x1b[1;1R')
    expect(conn.send).not.toHaveBeenCalled()
    newReady()
    input('user input')
    expect(conn.send).toHaveBeenCalledWith('user input')
  })

  it('holds typing until connected and replayed, without automatic replies', () => {
    render(<TerminalView id="t1" {...props} />)
    // Still connecting: the connection takes nothing yet.
    conn().send.mockReturnValue(false)
    const input = xterms[0].onData.mock.calls[0][0] as (data: string) => void
    input('ls')
    input('\x1b[3;1R')
    input('\r')
    conn().send.mockReturnValue(true)
    handlers().onReady()
    const ready = xterms[0].write.mock.calls.at(-1)![1] as () => void
    ready()
    expect(conn().send).toHaveBeenLastCalledWith('ls\r')
    input('x')
    expect(conn().send).toHaveBeenLastCalledWith('x')
  })

  // A flood keeps the replay (and a resync) from finishing on a slow
  // client; Ctrl-C must still reach the shell.
  it('sends typing at once while an open connection replays', () => {
    render(<TerminalView id="t1" {...props} />)
    conn().send.mockReturnValue(true)
    act(() => handlers().onReset('resync'))
    const input = xterms[0].onData.mock.calls[0][0] as (data: string) => void
    input('\x1b[3;1R')
    input('\x03')
    expect(conn().send.mock.calls).toEqual([['\x03']])
  })

  it('keeps the connection state per terminal', () => {
    render(<TerminalView id="t1" {...props} />)
    act(() => handlers().onState?.('reconnecting', 3))
    expect(useTerminalStore.getState().conn.t1).toEqual({ state: 'reconnecting', attempt: 3 })
  })

  it('checks the terminal still exists every few failed reconnects', () => {
    const onDisconnect = vi.fn()
    render(<TerminalView id="t1" {...props} onDisconnect={onDisconnect} />)
    act(() => handlers().onState?.('reconnecting', 4))
    expect(onDisconnect).not.toHaveBeenCalled()
    act(() => handlers().onState?.('reconnecting', 5))
    expect(onDisconnect).toHaveBeenCalledTimes(1)
  })

  it('stops taking input and blinking once the shell exits', () => {
    const onExit = vi.fn()
    render(<TerminalView id="t1" {...props} onExit={onExit} />)
    act(() => handlers().onExit(137))
    expect(xterms[0].options.disableStdin).toBe(true)
    expect(xterms[0].options.cursorBlink).toBe(false)
    // and hides the cursor: nothing will be typed there again
    expect(xterms[0].write).toHaveBeenLastCalledWith('\x1b[?25l')
    expect(onExit).toHaveBeenCalledWith(137)
  })

  it('reconnects a lost shell when it is shown again', () => {
    render(<TerminalView id="t1" {...props} />).unmount()
    act(() => handlers().onState?.('disconnected'))
    render(<TerminalView id="t1" {...props} />)
    expect(conn().reconnect).toHaveBeenCalledTimes(1)
    expect(connectTerminal).toHaveBeenCalledTimes(1)
  })

  it('keeps a long scrollback, opens links in a new tab and copies OSC 52 text', async () => {
    const open = vi.fn()
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('open', open)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    render(<TerminalView id="t1" {...props} />)
    expect(xterms[0].options.scrollback).toBe(10000)
    const links = vi.mocked(WebLinksAddon).mock.calls[0][0] as (e: MouseEvent, uri: string) => void
    links(new MouseEvent('click'), 'https://example.com')
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
    const [code, osc] = xterms[0].parser.registerOscHandler.mock.calls[0] as [number, (data: string) => boolean]
    expect(code).toBe(52)
    expect(osc('c;' + btoa('copied'))).toBe(true)
    expect(writeText).toHaveBeenCalledWith('copied')
  })

  it('sends only changed sizes, once per frame', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
    vi.stubGlobal('cancelAnimationFrame', () => {})
    let observed: () => void = () => {}
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { observed = cb } observe() {} disconnect() {} })
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
    render(<TerminalView id="t1" {...props} />)
    expect(conn().resize).toHaveBeenCalledTimes(1)
    observed()
    observed()
    expect(frames).toHaveLength(1)
    frames[0](0)
    expect(conn().resize).toHaveBeenCalledTimes(1)
    xterms[0].cols = 100
    observed()
    frames[1](0)
    expect(conn().resize).toHaveBeenLastCalledWith(100, 24)
    width.mockRestore()
  })

  it('focuses the screen each time its terminal is chosen', () => {
    const view = render(<TerminalView id="t1" {...props} autoFocus focusKey={1} />)
    expect(xterms[0].focus).toHaveBeenCalledTimes(1)
    view.rerender(<TerminalView id="t1" {...props} autoFocus focusKey={2} />)
    expect(xterms[0].focus).toHaveBeenCalledTimes(2)
  })

  it('sends the special keys through the same input path, with a sticky Ctrl', () => {
    render(<TerminalView id="t1" {...props} />)
    handlers().onReady()
    ;(xterms[0].write.mock.calls.at(-1)![1] as () => void)()
    sendKeys('t1', '\x1b')
    expect(conn().send).toHaveBeenLastCalledWith('\x1b')
    const released = vi.fn()
    setStickyCtrl('t1', true, released)
    const input = xterms[0].onData.mock.calls[0][0] as (data: string) => void
    input('c')
    expect(conn().send).toHaveBeenLastCalledWith('\x03')
    expect(released).toHaveBeenCalled()
    input('c')
    expect(conn().send).toHaveBeenLastCalledWith('c')
  })
})

describe('terminal keys, find and new output', () => {
  type Mock = ReturnType<typeof vi.fn>
  type Extra = { attachCustomKeyEventHandler: Mock; onScroll: Mock; buffer: { active: { viewportY: number; baseY: number } }; scrollToBottom: Mock; getSelection: Mock; clearSelection: Mock }
  const xt = () => xterms[0] as unknown as (typeof xterms)[number] & Extra
  const press = (over: Partial<KeyboardEventInit> & { code?: string }) => {
    const e = new KeyboardEvent('keydown', { cancelable: true, ...over })
    const handler = xt().attachCustomKeyEventHandler.mock.calls[0]![0] as (e: KeyboardEvent) => boolean
    return { passed: handler(e), prevented: e.defaultPrevented }
  }

  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    xterms.length = 0
    vi.mocked(connectTerminal).mockClear()
    localStorage.clear()
    resetTerminals()
    useTerminalStore.setState({ terminals: [shell('t1')] })
  })
  afterEach(() => {
    useTerminalStore.setState({ terminals: [] })
    vi.unstubAllGlobals()
  })

  it('leaves ordinary keys and Ctrl+C to the shell', () => {
    render(<TerminalView id="t1" {...props} />)
    expect(press({ key: 'a', code: 'KeyA' })).toEqual({ passed: true, prevented: false })
    expect(press({ key: 'c', code: 'KeyC', ctrlKey: true })).toEqual({ passed: true, prevented: false })
  })

  it('opens find, copies the selection and lets the browser paste', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    render(<TerminalView id="t1" {...props} />)
    expect(press({ key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true })).toEqual({ passed: false, prevented: true })
    expect(useTerminalStore.getState().finding).toBe('t1')
    press({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true })
    expect(writeText).not.toHaveBeenCalled()
    xt().getSelection.mockReturnValue('abc')
    press({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true })
    expect(writeText).toHaveBeenCalledWith('abc')
    expect(press({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true })).toEqual({ passed: false, prevented: false })
  })

  it('sizes the font of every screen and remembers it', () => {
    render(<TerminalView id="t1" {...props} />)
    expect(xt().options.fontSize).toBe(13)
    act(() => void press({ key: '=', code: 'Equal', ctrlKey: true }))
    act(() => void press({ key: '=', code: 'Equal', ctrlKey: true }))
    expect(xt().options.fontSize).toBe(15)
    act(() => void press({ key: '-', code: 'Minus', ctrlKey: true }))
    expect(xt().options.fontSize).toBe(14)
    expect(localStorage.getItem('gc.terminal.fontSize')).toBe('14')
    act(() => void press({ key: '0', code: 'Digit0', ctrlKey: true }))
    expect(xt().options.fontSize).toBe(13)
  })

  it('asks the tab list to step with Alt+[ and Alt+]', () => {
    const steps: number[] = []
    const listen = (e: Event) => steps.push((e as CustomEvent<number>).detail)
    window.addEventListener(STEP_EVENT, listen)
    render(<TerminalView id="t1" {...props} />)
    press({ key: '[', code: 'BracketLeft', altKey: true })
    press({ key: ']', code: 'BracketRight', altKey: true })
    window.removeEventListener(STEP_EVENT, listen)
    expect(steps).toEqual([-1, 1])
  })

  it('marks output that lands below while scrolled up, until back at the bottom', () => {
    render(<TerminalView id="t1" {...props} />)
    const out = vi.mocked(connectTerminal).mock.calls[0]![1]
    out.onOutput(new Uint8Array([1]))
    act(() => (xt().write.mock.calls.at(-1)![1] as () => void)())
    expect(useTerminalStore.getState().unseen).toEqual({})
    xt().buffer.active = { viewportY: 3, baseY: 40 }
    out.onOutput(new Uint8Array([2]))
    act(() => (xt().write.mock.calls.at(-1)![1] as () => void)())
    expect(useTerminalStore.getState().unseen).toEqual({ t1: true })
    const onScroll = xt().onScroll.mock.calls[0]![0] as () => void
    act(() => onScroll())
    expect(useTerminalStore.getState().unseen).toEqual({ t1: true })
    xt().buffer.active = { viewportY: 40, baseY: 40 }
    act(() => onScroll())
    expect(useTerminalStore.getState().unseen).toEqual({})
    act(() => useTerminalStore.getState().setUnseen('t1', true))
    act(() => scrollToBottom('t1'))
    expect(xt().scrollToBottom).toHaveBeenCalled()
    expect(useTerminalStore.getState().unseen).toEqual({})
  })

  it('searches the scrollback forwards and back, and clears the marks when done', () => {
    render(<TerminalView id="t1" {...props} />)
    const { SearchAddon } = vi.mocked(addonSearch)
    const search = vi.mocked(SearchAddon).mock.results.at(-1)!.value as { findNext: Mock; findPrevious: Mock; clearDecorations: Mock; onDidChangeResults: Mock }
    expect(findInTerminal('t1', 'err')).toBe(true)
    expect(search.findNext).toHaveBeenCalledWith('err', expect.objectContaining({ decorations: expect.objectContaining({ activeMatchBorder: '#2433d6' }) }))
    expect(findInTerminal('t1', 'err', { backwards: true })).toBe(false)
    expect(search.findPrevious).toHaveBeenCalled()
    expect(findInTerminal('t1', '')).toBe(false)
    expect(search.clearDecorations).toHaveBeenCalledTimes(1)
    const results = vi.fn()
    const stop = onFindResults('t1', results)
    ;(search.onDidChangeResults.mock.calls[0]![0] as (r: { resultIndex: number; resultCount: number }) => void)({ resultIndex: 1, resultCount: 4 })
    expect(results).toHaveBeenCalledWith({ index: 1, count: 4 })
    stop()
    endFind('t1')
    expect(search.clearDecorations).toHaveBeenCalledTimes(2)
    expect(xt().focus).toHaveBeenCalled()
    expect(findInTerminal('nope', 'x')).toBe(false)
  })
})
