import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectTerminal } from '../../lib/terminal'
import { resetTerminals, useTerminalStore } from '../../stores/terminals'
import TerminalView from './TerminalView'

const xterms: { dispose: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn> }[] = []
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
})
