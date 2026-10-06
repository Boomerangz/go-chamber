import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Terminal } from '../../lib/terminal'
import { useNotices } from '../../stores/notices'
import { resetTerminals, useTerminalStore } from '../../stores/terminals'
import TerminalPanel from './TerminalPanel'
import TerminalWorkspace from './TerminalWorkspace'
import TerminalScreen, { ConnectionLine } from './TerminalScreen'
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
  findInTerminal: vi.fn(() => true),
  onFindResults: vi.fn(() => () => {}),
  endFind: vi.fn(),
  scrollToBottom: vi.fn(),
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
    const field = screen.getByLabelText('Terminal directory')
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
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(api.closeTerminal).toHaveBeenCalledWith('t1')
    ;(api.closeTerminal as Mock).mockClear()
    cleanup()
    act(() => useTerminalStore.setState({ terminals: [term({ status: 'exited', exitCode: 137 })] }))
    render(<ConnectionLine id="t1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Open again here' }))
    expect(api.openTerminal).toHaveBeenCalledWith({ cwd: '/home/me/app' })
    expect(useTerminalStore.getState().terminals.map((t) => t.id)).toEqual(['t2'])
  })

  it('offers to reconnect now while it waits to retry', async () => {
    useTerminalStore.setState({ terminals: [term()], conn: { t1: { state: 'reconnecting', attempt: 2 } } })
    render(<ConnectionLine id="t1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect now' }))
    expect(live.reconnectTerminal).toHaveBeenCalledWith('t1')
  })

  it('keeps a clean exit in ink', () => {
    useTerminalStore.setState({ terminals: [term({ status: 'exited', exitCode: 0 })] })
    render(<ConnectionLine id="t1" />)
    expect(screen.getByText('exited 0')).not.toHaveClass('term-bad')
  })
})

describe('TerminalScreen', () => {
  it('finds in the scrollback from the newest output up: older, newer, counts and Escape back to the shell', async () => {
    useTerminalStore.setState({ terminals: [term()], finding: 't1' })
    render(<TerminalScreen id="t1" />)
    const field = screen.getByRole('searchbox', { name: 'Find in terminal' })
    expect(field).toHaveFocus()
    await userEvent.type(field, 'err')
    expect(live.findInTerminal).toHaveBeenLastCalledWith('t1', 'err', { incremental: true, backwards: true })
    const report = vi.mocked(live.onFindResults).mock.calls[0]![1]
    act(() => report({ index: 2, count: 5 }))
    expect(screen.getByText('3 of 5')).toBeInTheDocument()
    await userEvent.keyboard('{Enter}')
    expect(live.findInTerminal).toHaveBeenLastCalledWith('t1', 'err', { backwards: true })
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}')
    expect(live.findInTerminal).toHaveBeenLastCalledWith('t1', 'err', { backwards: false })
    await userEvent.click(screen.getByRole('button', { name: 'Newer match' }))
    expect(live.findInTerminal).toHaveBeenLastCalledWith('t1', 'err', {})
    await userEvent.click(screen.getByRole('button', { name: 'Older match' }))
    expect(live.findInTerminal).toHaveBeenLastCalledWith('t1', 'err', { backwards: true })
    vi.mocked(live.findInTerminal).mockReturnValueOnce(false)
    await userEvent.type(field, 'x')
    act(() => report({ index: -1, count: 0 }))
    expect(screen.getByText('no matches')).toBeInTheDocument()
    await userEvent.type(field, '{Escape}')
    expect(live.endFind).toHaveBeenCalledWith('t1')
    expect(useTerminalStore.getState().finding).toBeNull()
  })

  it('drops the phone keys once the shell has exited', () => {
    useTerminalStore.setState({ terminals: [term({ status: 'exited', exitCode: 1 })] })
    render(<TerminalScreen id="t1" />)
    expect(screen.queryByRole('button', { name: 'Escape' })).toBeNull()
    cleanup()
    act(() => useTerminalStore.setState({ terminals: [term()] }))
    render(<TerminalScreen id="t1" />)
    expect(screen.getByRole('button', { name: 'Escape' })).toBeInTheDocument()
  })

  it('shows the new text size for a moment after a zoom', () => {
    vi.useFakeTimers()
    useTerminalStore.setState({ terminals: [term()] })
    render(<TerminalScreen id="t1" />)
    expect(screen.queryByText(/^\d+px$/)).toBeNull()
    act(() => useTerminalStore.getState().setFontSize(17))
    expect(screen.getByRole('status', { name: 'Text size' })).toHaveTextContent('17px')
    act(() => vi.advanceTimersByTime(2000))
    expect(screen.queryByText('17px')).toBeNull()
  })

  it('offers to jump to new output below', async () => {
    useTerminalStore.setState({ terminals: [term()] })
    render(<TerminalScreen id="t1" />)
    expect(screen.queryByRole('button', { name: /new output/ })).toBeNull()
    act(() => useTerminalStore.getState().setUnseen('t1', true))
    await userEvent.click(screen.getByRole('button', { name: /new output/ }))
    expect(live.scrollToBottom).toHaveBeenCalledWith('t1')
  })
})

describe('TerminalWorkspace on a phone', () => {
  it('folds the list to a one-line switcher while a shell is attached', async () => {
    useTerminalStore.setState({ terminals: [term(), term({ id: 't2', title: 'logs' })], activeId: 't1', loaded: true })
    const { container } = render(<TerminalWorkspace sessions={[]} />)
    const aside = container.querySelector('.term-sidebar')!
    expect(aside).toHaveAttribute('data-collapsed', 'true')
    const toggle = screen.getByRole('button', { name: /Shells/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(toggle)
    expect(aside).not.toHaveAttribute('data-collapsed')
    await userEvent.click(screen.getByRole('tab', { name: /logs/ }))
    expect(useTerminalStore.getState().activeId).toBe('t2')
    expect(aside).toHaveAttribute('data-collapsed', 'true')
  })

  it('marks only the project chip being opened as busy', async () => {
    useTerminalStore.setState({ loaded: true })
    ;(api.openTerminal as Mock).mockReturnValue(new Promise(() => {}))
    render(<TerminalWorkspace sessions={[{ id: 's', agent: 'claude', cwd: '/w/one', status: 'idle' }, { id: 'r', agent: 'claude', cwd: '/w/two', status: 'idle' }]} />)
    await userEvent.click(screen.getByRole('button', { name: 'Open terminal in one' }))
    expect(screen.getByRole('button', { name: 'Open terminal in one' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'Open terminal in two' })).not.toHaveAttribute('aria-busy')
    expect(screen.getByRole('button', { name: 'New terminal' })).not.toHaveAttribute('aria-busy')
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

  it('types the characters and paging keys a phone keyboard hides, and opens find', async () => {
    render(<TerminalKeys id="t1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Type |' }))
    expect(live.sendKeys).toHaveBeenLastCalledWith('t1', '|')
    await userEvent.click(screen.getByRole('button', { name: 'Type ~' }))
    expect(live.sendKeys).toHaveBeenLastCalledWith('t1', '~')
    await userEvent.click(screen.getByRole('button', { name: 'Page up' }))
    expect(live.sendKeys).toHaveBeenLastCalledWith('t1', '\x1b[5~')
    await userEvent.click(screen.getByRole('button', { name: 'Home' }))
    expect(live.sendKeys).toHaveBeenLastCalledWith('t1', '\x1b[H')
    await userEvent.click(screen.getByRole('button', { name: 'End of input' }))
    expect(live.sendKeys).toHaveBeenLastCalledWith('t1', '\x04')
    await userEvent.click(screen.getByRole('button', { name: 'Find' }))
    expect(useTerminalStore.getState().finding).toBe('t1')
  })

  it('pastes the clipboard into the terminal', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { readText: () => Promise.resolve('ls') } })
    render(<TerminalKeys id="t1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Paste' }))
    expect(live.pasteInto).toHaveBeenCalledWith('t1', 'ls')
  })
})

describe('TerminalPanel', () => {
  it('scrolls the selected tab fully into view, also after a rename', async () => {
    const seen: Element[] = []
    const scroll = vi.fn(function (this: Element) { seen.push(this) })
    Element.prototype.scrollIntoView = scroll
    useTerminalStore.setState({ loaded: true, terminals: [term({ id: 'a', title: 'one' }), term({ id: 'b', title: 'two' })], activeId: 'a' })
    render(<TerminalPanel sessionId={null} />)
    act(() => useTerminalStore.getState().select('b'))
    expect(seen.at(-1)).toBe(screen.getByRole('tab', { name: /two/ }).closest('li'))
    expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest' })
    const calls = scroll.mock.calls.length
    act(() => useTerminalStore.setState({ terminals: [term({ id: 'a', title: 'one' }), term({ id: 'b', title: 'a much longer name' })] }))
    expect(scroll.mock.calls.length).toBe(calls + 1)
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })

  it('fades the edge of the tab strip where tabs are hidden', () => {
    useTerminalStore.setState({ loaded: true, terminals: [term({ id: 'a' }), term({ id: 'b' })], activeId: 'a' })
    render(<TerminalPanel sessionId={null} />)
    const strip = screen.getByRole('tablist')
    Object.defineProperties(strip, { scrollWidth: { value: 600, configurable: true }, clientWidth: { value: 300, configurable: true } })
    strip.scrollLeft = 0
    fireEvent.scroll(strip)
    expect(strip).toHaveAttribute('data-fade', 'end')
    strip.scrollLeft = 100
    fireEvent.scroll(strip)
    expect(strip).toHaveAttribute('data-fade', 'both')
    strip.scrollLeft = 300
    fireEvent.scroll(strip)
    expect(strip).toHaveAttribute('data-fade', 'start')
  })

  it('opens a shell in the session folder from "+", and elsewhere from its menu', async () => {
    useTerminalStore.setState({ loaded: true })
    ;(api.openTerminal as Mock).mockResolvedValue(term())
    render(<TerminalPanel sessionId="s1" />)
    expect(screen.queryByLabelText('Terminal directory')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'New terminal in session dir' }))
    expect(api.openTerminal).toHaveBeenCalledWith({ sessionId: 's1' })
    await userEvent.click(screen.getByRole('button', { name: 'Open a terminal elsewhere' }))
    await userEvent.click(screen.getByRole('button', { name: 'Home folder' }))
    expect(api.openTerminal).toHaveBeenLastCalledWith({})
    expect(screen.queryByRole('button', { name: 'Home folder' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Open a terminal elsewhere' }))
    await userEvent.type(screen.getByLabelText('Terminal directory'), '/srv{Enter}')
    expect(api.openTerminal).toHaveBeenLastCalledWith({ cwd: '/srv' })
  })

  it("lists the session's shells first and renames a tab on double click", async () => {
    useTerminalStore.setState({
      loaded: true,
      terminals: [term({ id: 'a', title: 'other' }), term({ id: 'b', title: 'mine', sessionId: 's1' })],
    })
    ;(api.renameTerminal as Mock).mockResolvedValue(term({ id: 'b', title: 'logs' }))
    render(<TerminalPanel sessionId="s1" />)
    expect(screen.getAllByRole('tab').map((t) => t.querySelector('.term-tab-title')!.textContent)).toEqual(['mine', 'other'])
    expect(screen.getByRole('tab', { name: /mine/ })).toHaveTextContent('mineapp')
    await userEvent.dblClick(screen.getByRole('tab', { name: /mine/ }))
    const input = screen.getByRole('textbox', { name: 'Terminal name' })
    await userEvent.clear(input)
    await userEvent.type(input, 'logs{Enter}')
    expect(api.renameTerminal).toHaveBeenCalledWith('b', 'logs')
  })

  it('shows each tab’s folder and offers a visible rename on the chosen tab', async () => {
    useTerminalStore.setState({ loaded: true, activeId: 'b', terminals: [term({ id: 'a', title: 'app' }), term({ id: 'b', title: 'logs', cwd: '/srv/api' })] })
    ;(api.renameTerminal as Mock).mockReturnValue(new Promise(() => {}))
    render(<TerminalPanel sessionId={null} />)
    // A title that already is the folder name isn't repeated.
    expect(screen.getByRole('tab', { name: /app/ }).querySelector('.term-tab-cwd')).toBeNull()
    expect(screen.getByRole('tab', { name: /logs/ })).toHaveTextContent('logsapi')
    expect(screen.getAllByRole('button', { name: /^Rename terminal/ })).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Rename terminal logs' }))
    const input = screen.getByRole('textbox', { name: 'Terminal name' })
    await userEvent.clear(input)
    await userEvent.type(input, 'tail{Enter}')
    // The new title shows before the server answers.
    expect(screen.getByRole('tab', { name: /tail/ })).toBeInTheDocument()
  })

  it('steps between tabs with Alt+[ and Alt+], in the order shown', async () => {
    useTerminalStore.setState({ loaded: true, activeId: 'a', terminals: [term({ id: 'a', title: 'one' }), term({ id: 'b', title: 'two', sessionId: 's1' })] })
    render(<TerminalPanel sessionId="s1" />)
    // The session's own shell comes first, so "a" is second.
    act(() => void window.dispatchEvent(new CustomEvent('gc:terminal-step', { detail: -1 })))
    expect(useTerminalStore.getState().activeId).toBe('b')
    fireEvent.keyDown(screen.getByRole('tab', { name: /two/ }), { code: 'BracketRight', altKey: true })
    expect(useTerminalStore.getState().activeId).toBe('a')
    fireEvent.keyDown(screen.getByRole('tab', { name: /one/ }), { code: 'BracketRight', altKey: true })
    expect(useTerminalStore.getState().activeId).toBe('a')
  })

  it('keeps each open button busy only for its own request', async () => {
    useTerminalStore.setState({ loaded: true })
    ;(api.openTerminal as Mock).mockReturnValue(new Promise(() => {}))
    render(<TerminalPanel sessionId="s1" />)
    await userEvent.click(screen.getByRole('button', { name: 'New terminal in session dir' }))
    expect(screen.getByRole('button', { name: 'New terminal in session dir' })).toHaveAttribute('aria-busy', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Open a terminal elsewhere' }))
    expect(screen.getByRole('button', { name: 'Home folder' })).not.toHaveAttribute('aria-busy')
    await userEvent.click(screen.getByRole('button', { name: 'Home folder' }))
    expect(screen.getByRole('button', { name: 'Opening…' })).toHaveAttribute('aria-busy', 'true')
    expect(api.openTerminal).toHaveBeenCalledTimes(2)
  })

  it('says when a reload of the list failed, even after a first load', async () => {
    useTerminalStore.setState({ loaded: true, terminals: [term()], loadError: 'offline' })
    ;(api.listTerminals as Mock).mockResolvedValue([term()])
    render(<TerminalPanel sessionId={null} />)
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't refresh shells: offline")
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says shells are loading before the list arrives', () => {
    render(<TerminalPanel sessionId={null} />)
    expect(screen.getByRole('status')).toHaveTextContent('loading shells…')
    expect(screen.getByRole('button', { name: 'New terminal in home folder' })).toBeInTheDocument()
  })
})
