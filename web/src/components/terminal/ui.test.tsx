import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Terminal } from '../../lib/terminal'
import { useNotices } from '../../stores/notices'
import { resetTerminals, useTerminalStore } from '../../stores/terminals'
import TerminalPanel from './TerminalPanel'
import TerminalWorkspace from './TerminalWorkspace'
import { ConnectionLine } from './TerminalScreen'
import TerminalKeys from './TerminalKeys'
import * as live from './live'

vi.mock('../../lib/terminal', () => ({
  listTerminals: vi.fn(),
  openTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  renameTerminal: vi.fn(),
}))
vi.mock('./TerminalView', () => ({ default: () => <div data-testid="terminal-view" /> }))
vi.mock('./live', () => ({
  reconnectTerminal: vi.fn(),
  sendKeys: vi.fn(),
  pasteInto: vi.fn(),
  setStickyCtrl: vi.fn(),
}))

import * as api from '../../lib/terminal'

const term = (over: Partial<Terminal> = {}): Terminal => ({
  id: 't1', cwd: '/home/me/app', shell: '/bin/zsh', title: 'app', status: 'running', exitCode: 0, createdAt: '', ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  resetTerminals()
  useNotices.setState({ notices: [] })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('TerminalWorkspace', () => {
  it('says shells are loading until the list arrives, and offers a retry when it fails', async () => {
    render(<TerminalWorkspace sessions={[]} />)
    expect(screen.getByRole('status')).toHaveTextContent('loading shells…')
    expect(screen.queryByText('No shells yet.')).toBeNull()
    act(() => useTerminalStore.setState({ loadError: 'offline' }))
    ;(api.listTerminals as Mock).mockResolvedValue([])
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No shells yet.')).toBeInTheDocument()
  })

  it('asks before killing a running shell, and forgets the question after a while', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    useTerminalStore.setState({ terminals: [term()], loaded: true })
    render(<TerminalWorkspace sessions={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close terminal app' }))
    expect(screen.getByText('kill shell?')).toBeInTheDocument()
    expect(api.closeTerminal).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(4000))
    expect(screen.queryByText('kill shell?')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close terminal app' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    expect(screen.queryByText('kill shell?')).toBeNull()
    ;(api.closeTerminal as Mock).mockReturnValue(new Promise(() => {}))
    fireEvent.click(screen.getByRole('button', { name: 'Close terminal app' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(api.closeTerminal).toHaveBeenCalledWith('t1')
    expect(screen.getByRole('tab', { name: /app/ }).closest('li')).toHaveClass('closing')
    expect(screen.getByRole('button', { name: 'Close terminal app' })).toBeDisabled()
  })

  it('closes an exited shell at once and shows a single mark for it', async () => {
    useTerminalStore.setState({ terminals: [term({ status: 'exited', exitCode: 137 })], loaded: true })
    ;(api.closeTerminal as Mock).mockResolvedValue(undefined)
    const { container } = render(<TerminalWorkspace sessions={[]} />)
    const tab = screen.getByRole('tab', { name: /app/ })
    expect(tab).toHaveTextContent('exited 137')
    expect(tab.querySelectorAll('.term-dot, .status')).toHaveLength(1)
    expect(container.querySelector('.term-dot')).toHaveAttribute('data-mark', 'struck')
    await userEvent.click(screen.getByRole('button', { name: 'Close terminal app' }))
    expect(api.closeTerminal).toHaveBeenCalledWith('t1')
  })

  it('keeps the folder until the shell opens and shows why it did not', async () => {
    useTerminalStore.setState({ loaded: true })
    ;(api.openTerminal as Mock).mockRejectedValueOnce(new Error('no such folder'))
    render(<TerminalWorkspace sessions={[]} />)
    const field = screen.getByLabelText('terminal directory')
    await userEvent.type(field, '/nope')
    await userEvent.click(screen.getByRole('button', { name: 'New terminal' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('no such folder')
    expect(field).toHaveValue('/nope')
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()
    let release: (t: Terminal) => void = () => {}
    ;(api.openTerminal as Mock).mockReturnValueOnce(new Promise((r) => (release = r)))
    await userEvent.click(screen.getByRole('button', { name: 'New terminal' }))
    expect(screen.getAllByRole('button', { name: 'Opening…' })[0]).toHaveAttribute('aria-busy', 'true')
    await act(async () => release(term({ cwd: '/nope' })))
    expect(field).toHaveValue('')
  })

  it('offers a shell in home from the empty screen and says when a linked terminal is gone', async () => {
    useTerminalStore.setState({ loaded: true, missingId: 'gone' })
    ;(api.openTerminal as Mock).mockResolvedValue(term())
    render(<TerminalWorkspace sessions={[]} />)
    expect(screen.getByText('terminal no longer exists')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Open shell in ~' }))
    expect(api.openTerminal).toHaveBeenCalledWith({})
  })

  it('copies the folder of the open shell', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    useTerminalStore.setState({ terminals: [term()], activeId: 't1', loaded: true })
    render(<TerminalWorkspace sessions={[]} />)
    await userEvent.click(screen.getByRole('button', { name: 'Copy folder path' }))
    expect(writeText).toHaveBeenCalledWith('/home/me/app')
    expect(useNotices.getState().notices.at(-1)).toMatchObject({ kind: 'info' })
    expect(screen.getByRole('button', { name: 'Close this shell' })).toBeInTheDocument()
  })
})

describe('ConnectionLine', () => {
  it('stays out of the way while live', () => {
    useTerminalStore.setState({ terminals: [term()], conn: { t1: { state: 'live' } } })
    const { container } = render(<ConnectionLine id="t1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('says it is connecting or reconnecting with the attempt', () => {
    useTerminalStore.setState({ terminals: [term()], conn: { t1: { state: 'connecting' } } })
    const view = render(<ConnectionLine id="t1" />)
    expect(screen.getByRole('status')).toHaveTextContent('connecting…')
    expect(view.container.querySelector('.term-dot')).toHaveAttribute('data-mark', 'pending')
    act(() => useTerminalStore.setState({ conn: { t1: { state: 'reconnecting', attempt: 3 } } }))
    expect(screen.getByRole('status')).toHaveTextContent('reconnecting… (attempt 3)')
  })

  it('offers to reconnect a lost connection', async () => {
    useTerminalStore.setState({ terminals: [term()], conn: { t1: { state: 'disconnected' } } })
    const view = render(<ConnectionLine id="t1" />)
    expect(view.container.querySelector('.term-dot')).toHaveAttribute('data-mark', 'struck')
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(live.reconnectTerminal).toHaveBeenCalledWith('t1')
  })

  it('shows the exit code, red when it failed, and offers to open again or close', async () => {
    useTerminalStore.setState({ terminals: [term({ status: 'exited', exitCode: 137 })] })
    ;(api.openTerminal as Mock).mockResolvedValue(term({ id: 't2' }))
    ;(api.closeTerminal as Mock).mockResolvedValue(undefined)
    render(<ConnectionLine id="t1" />)
    expect(screen.getByText('exited 137')).toHaveClass('term-bad')
    await userEvent.click(screen.getByRole('button', { name: 'Open again here' }))
    expect(api.openTerminal).toHaveBeenCalledWith({ cwd: '/home/me/app' })
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(api.closeTerminal).toHaveBeenCalledWith('t1')
  })

  it('keeps a clean exit in ink', () => {
    useTerminalStore.setState({ terminals: [term({ status: 'exited', exitCode: 0 })] })
    render(<ConnectionLine id="t1" />)
    expect(screen.getByText('exited 0')).not.toHaveClass('term-bad')
  })
})

describe('TerminalKeys', () => {
  it('types the special keys and arms a sticky Ctrl', async () => {
    render(<TerminalKeys id="t1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Escape' }))
    expect(live.sendKeys).toHaveBeenCalledWith('t1', '\x1b')
    await userEvent.click(screen.getByRole('button', { name: 'Up' }))
    expect(live.sendKeys).toHaveBeenLastCalledWith('t1', '\x1b[A')
    await userEvent.click(screen.getByRole('button', { name: 'Interrupt' }))
    expect(live.sendKeys).toHaveBeenLastCalledWith('t1', '\x03')
    const ctrl = screen.getByRole('button', { name: 'Control' })
    await userEvent.click(ctrl)
    expect(ctrl).toHaveAttribute('aria-pressed', 'true')
    const release = vi.mocked(live.setStickyCtrl).mock.calls.at(-1)![2]
    act(() => release())
    expect(ctrl).toHaveAttribute('aria-pressed', 'false')
  })

  it('pastes the clipboard into the terminal', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { readText: () => Promise.resolve('ls') } })
    render(<TerminalKeys id="t1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Paste' }))
    expect(live.pasteInto).toHaveBeenCalledWith('t1', 'ls')
  })
})

describe('TerminalPanel', () => {
  it('opens a shell in the session folder from "+", and elsewhere from its menu', async () => {
    useTerminalStore.setState({ loaded: true })
    ;(api.openTerminal as Mock).mockResolvedValue(term())
    render(<TerminalPanel sessionId="s1" />)
    expect(screen.queryByLabelText('terminal directory')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'New terminal in session dir' }))
    expect(api.openTerminal).toHaveBeenCalledWith({ sessionId: 's1' })
    await userEvent.click(screen.getByRole('button', { name: 'Open a terminal elsewhere' }))
    await userEvent.click(screen.getByRole('button', { name: 'Home folder' }))
    expect(api.openTerminal).toHaveBeenLastCalledWith({})
    expect(screen.queryByRole('button', { name: 'Home folder' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Open a terminal elsewhere' }))
    await userEvent.type(screen.getByLabelText('terminal directory'), '/srv{Enter}')
    expect(api.openTerminal).toHaveBeenLastCalledWith({ cwd: '/srv' })
  })

  it("lists the session's shells first and renames a tab on double click", async () => {
    useTerminalStore.setState({
      loaded: true,
      terminals: [term({ id: 'a', title: 'other' }), term({ id: 'b', title: 'mine', sessionId: 's1' })],
    })
    ;(api.renameTerminal as Mock).mockResolvedValue(term({ id: 'b', title: 'logs' }))
    render(<TerminalPanel sessionId="s1" />)
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['mine', 'other'])
    await userEvent.dblClick(screen.getByRole('tab', { name: /mine/ }))
    const input = screen.getByRole('textbox', { name: 'terminal name' })
    await userEvent.clear(input)
    await userEvent.type(input, 'logs{Enter}')
    expect(api.renameTerminal).toHaveBeenCalledWith('b', 'logs')
  })

  it('says shells are loading before the list arrives', () => {
    render(<TerminalPanel sessionId={null} />)
    expect(screen.getByRole('status')).toHaveTextContent('loading shells…')
    expect(screen.getByRole('button', { name: 'New terminal in home folder' })).toBeInTheDocument()
  })
})
