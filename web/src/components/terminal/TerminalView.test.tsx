import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectTerminal } from '../../lib/terminal'
import { diagnostics, resetDiagnostics } from '../../lib/diagnostics'
import { resetTerminals, useTerminalStore } from '../../stores/terminals'
import TerminalView from './TerminalView'

const xterms: {
  dispose: ReturnType<typeof vi.fn>
  open: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  reset: ReturnType<typeof vi.fn>
  onData: ReturnType<typeof vi.fn>
}[] = []
vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(function (this: Record<string, unknown>) {
    const t = {
      cols: 80,
      rows: 24,
      options: {},
      unicode: { activeVersion: '6' },
      loadAddon: vi.fn(),
      open: vi.fn((el: HTMLElement) => el.appendChild(document.createElement('canvas'))),
      write: vi.fn(),
      reset: vi.fn(),
      focus: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      parser: { registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })) },
      dispose: vi.fn(),
    }
    xterms.push(t)
    return t
  }),
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(function () { return { fit: vi.fn() } }) }))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: vi.fn(function () { return {} }) }))
vi.mock('../../lib/terminal', () => ({ connectTerminal: vi.fn(() => ({ send: vi.fn(), resize: vi.fn(), close: vi.fn() })) }))

const shell = (id: string) => ({ id, cwd: '/', shell: 'sh', title: id, status: 'running' as const, exitCode: 0, createdAt: '' })
const props = { autoFocus: false, onExit: () => {}, onDisconnect: () => {} }

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
})
