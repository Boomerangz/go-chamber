import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Terminal } from '../../lib/terminal'
import { useNotices } from '../../stores/notices'
import { resetTerminals, useTerminalStore } from '../../stores/terminals'
import { resetStore, useSessionStore } from '../../stores/session'
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
  resetStore()
  useNotices.setState({ notices: [] })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('TerminalWorkspace', () => {
  it('says shells are loading until the list arrives, and offers a retry when it fails', async () => {
    render(<TerminalWorkspace sessions={[]} />)
    expect(screen.getByRole('status')).toHaveTextContent('loading terminals…')
    expect(screen.queryByText('No terminals yet.')).toBeNull()
    act(() => useTerminalStore.setState({ loadError: 'offline' }))
    ;(api.listTerminals as Mock).mockResolvedValue([])
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No terminals yet.')).toBeInTheDocument()
  })

  it('asks before killing a running shell, and forgets the question after a while', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    useTerminalStore.setState({ terminals: [term()], loaded: true })
    render(<TerminalWorkspace sessions={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close terminal app' }))
    expect(screen.getByText('kill terminal?')).toBeInTheDocument()
    expect(api.closeTerminal).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(4000))
    expect(screen.queryByText('kill terminal?')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close terminal app' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    expect(screen.queryByText('kill terminal?')).toBeNull()
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
    const field = screen.getByLabelText('Terminal folder')
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
    await userEvent.click(screen.getByRole('button', { name: 'Open terminal in ~' }))
    expect(api.openTerminal).toHaveBeenCalledWith({})
  })

  it('copies the folder of the open shell', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    useTerminalStore.setState({ terminals: [term()], activeId: 't1', loaded: true })
    render(<TerminalWorkspace sessions={[]} />)
    await userEvent.click(screen.getByRole('button', { name: 'Copy folder path' }))
    expect(writeText).toHaveBeenCalledWith('/home/me/app')
    expect(useNotices.getState().notices.at(-1)).toMatchObject({ kind: 'info', text: 'Copied the folder path' })
    writeText.mockRejectedValueOnce(new Error('denied'))
    await userEvent.click(screen.getByRole('button', { name: 'Copy folder path' }))
    expect(useNotices.getState().notices.at(-1)).toMatchObject({ kind: 'error', title: "Couldn't copy the folder path" })
    expect(screen.getByRole('button', { name: 'Close this terminal' })).toBeInTheDocument()
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
    expect(field).toHaveAttribute('placeholder', 'Find in scrollback')
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
  const phone = () =>
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('max-width'), addEventListener: () => {}, removeEventListener: () => {} }))
  it('folds the list to a one-line switcher while a shell is attached', async () => {
    useTerminalStore.setState({ terminals: [term(), term({ id: 't2', title: 'logs' })], activeId: 't1', loaded: true })
    const { container } = render(<TerminalWorkspace sessions={[]} />)
    const aside = container.querySelector('.term-sidebar')!
    expect(aside).toHaveAttribute('data-collapsed', 'true')
    const toggle = screen.getByRole('button', { name: /Terminals/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(toggle)
    expect(aside).not.toHaveAttribute('data-collapsed')
    await userEvent.click(screen.getByRole('tab', { name: /logs/ }))
    expect(useTerminalStore.getState().activeId).toBe('t2')
    expect(aside).toHaveAttribute('data-collapsed', 'true')
  })

  it('unfolds to the shells first, with a new shell folded after them', async () => {
    phone()
    useTerminalStore.setState({ terminals: [term(), term({ id: 't2', title: 'logs' })], activeId: 't1', loaded: true })
    const { container } = render(<TerminalWorkspace sessions={[{ id: 's', agent: 'claude', cwd: '/w/one', status: 'idle' }]} />)
    await userEvent.click(screen.getByRole('button', { name: /Terminals/ }))
    const area = container.querySelector('.term-new-area')!
    expect(area).toContainElement(screen.getByRole('button', { name: 'New terminal' }))
    expect(area).toContainElement(screen.getByRole('button', { name: 'Open terminal in one' }))
    expect(area).toHaveAttribute('data-folded', 'true')
    const more = screen.getByRole('button', { name: 'Open another' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    // the list comes before the fold in the reading order
    expect(screen.getByRole('tablist').compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await userEvent.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    expect(area).not.toHaveAttribute('data-folded')
  })

  it('keeps a failed open in view rather than folded away', () => {
    phone()
    useTerminalStore.setState({ terminals: [term()], activeId: 't1', loaded: true, openError: 'no such folder' })
    const { container } = render(<TerminalWorkspace sessions={[]} />)
    expect(container.querySelector('.term-new-area')).not.toHaveAttribute('data-folded')
  })

  it('shows the new-shell form unfolded while nothing is attached', () => {
    phone()
    useTerminalStore.setState({ terminals: [term()], loaded: true })
    const { container } = render(<TerminalWorkspace sessions={[]} />)
    expect(container.querySelector('.term-new-area')).not.toHaveAttribute('data-folded')
    expect(screen.queryByRole('button', { name: 'Open another' })).toBeNull()
  })

  it('offers each live worktree beside its repository, and opens a shell in it', async () => {
    useTerminalStore.setState({ loaded: true })
    ;(api.openTerminal as Mock).mockReturnValue(new Promise(() => {}))
    const wt = (id: string, path: string, removed = false) => ({
      id, agent: 'claude' as const, cwd: path, status: 'idle' as const,
      worktree: { repo: '/w/app', path, branch: `chamber/${id}`, base: 'main', removed },
    })
    render(<TerminalWorkspace sessions={[{ id: 's', agent: 'claude', cwd: '/w/app', status: 'idle' }, wt('phone-fix', '/data/wt/app/phone-fix'), wt('old', '/data/wt/app/old', true)]} />)
    const chip = screen.getByRole('button', { name: 'Open terminal in app ⎇ phone-fix' })
    expect(chip).toHaveAttribute('title', '/data/wt/app/phone-fix')
    expect(screen.queryByRole('button', { name: /old/ })).toBeNull()
    // the repository's own chip comes first
    expect(screen.getByRole('button', { name: 'Open terminal in app' }).compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await userEvent.click(chip)
    expect(api.openTerminal).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/data/wt/app/phone-fix' }))
  })

  it('still offers a live worktree whose repository is not among the recent projects', () => {
    useTerminalStore.setState({ loaded: true })
    const others = Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, agent: 'claude' as const, cwd: `/w/other-${i}`, status: 'idle' as const }))
    const wt = { id: 'w', agent: 'claude' as const, cwd: '/data/wt/app/fix', status: 'idle' as const, worktree: { repo: '/w/app', path: '/data/wt/app/fix', branch: 'chamber/fix', base: 'main' } }
    render(<TerminalWorkspace sessions={[wt, ...others]} />)
    expect(screen.queryByRole('button', { name: 'Open terminal in app' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Open terminal in app ⎇ fix' })).toBeInTheDocument()
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

  it('names what it could not paste into', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { readText: () => Promise.reject(new Error('denied')) } })
    render(<TerminalKeys id="t1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Paste' }))
    expect(useNotices.getState().notices.at(-1)).toMatchObject({ kind: 'error', title: "Couldn't paste into the terminal" })
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
    expect(screen.queryByLabelText('Terminal folder')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'New terminal in session folder' }))
    expect(api.openTerminal).toHaveBeenCalledWith({ sessionId: 's1' })
    await userEvent.click(screen.getByRole('button', { name: 'More terminals' }))
    await userEvent.click(screen.getByRole('button', { name: 'Home folder' }))
    expect(api.openTerminal).toHaveBeenLastCalledWith({})
    expect(screen.queryByRole('button', { name: 'Home folder' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'More terminals' }))
    expect(screen.getByLabelText('Terminal folder')).toHaveAttribute('placeholder', 'Another folder')
    await userEvent.type(screen.getByLabelText('Terminal folder'), '/srv{Enter}')
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
    await userEvent.click(screen.getByRole('button', { name: 'New terminal in session folder' }))
    expect(screen.getByRole('button', { name: 'New terminal in session folder' })).toHaveAttribute('aria-busy', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'More terminals' }))
    expect(screen.getByRole('button', { name: 'Home folder' })).not.toHaveAttribute('aria-busy')
    await userEvent.click(screen.getByRole('button', { name: 'Home folder' }))
    expect(screen.getByRole('button', { name: 'Opening…' })).toHaveAttribute('aria-busy', 'true')
    expect(api.openTerminal).toHaveBeenCalledTimes(2)
  })

  it('says when a reload of the list failed, even after a first load', async () => {
    useTerminalStore.setState({ loaded: true, terminals: [term()], loadError: 'offline' })
    ;(api.listTerminals as Mock).mockResolvedValue([term()])
    render(<TerminalPanel sessionId={null} />)
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't refresh terminals: offline")
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it("doesn't repeat a folder the title already names", () => {
    useTerminalStore.setState({ loaded: true, terminals: [term({ id: 'a', title: 'repo60 2', cwd: '/w/repo60' }), term({ id: 'b', title: 'API logs', cwd: '/w/api' })] })
    render(<TerminalPanel sessionId={null} />)
    expect(screen.getByRole('tab', { name: /repo60 2/ }).querySelector('.term-tab-cwd')).toBeNull()
    expect(screen.getByRole('tab', { name: /API logs/ }).querySelector('.term-tab-cwd')).toBeNull()
  })

  it('lists every shell in the ▾ menu, the attached one marked, and attaches the one picked', async () => {
    const many = Array.from({ length: 10 }, (_, i) => term({ id: `t${i}`, title: `shell ${i}` }))
    useTerminalStore.setState({ loaded: true, terminals: many, activeId: 't0' })
    render(<TerminalPanel sessionId={null} />)
    await userEvent.click(screen.getByRole('button', { name: 'More terminals' }))
    const all = screen.getByRole('group', { name: 'All terminals' })
    const items = within(all).getAllByRole('button')
    expect(items).toHaveLength(10)
    expect(items[0]).toHaveAttribute('aria-current', 'true')
    await userEvent.click(within(all).getByRole('button', { name: /shell 7/ }))
    expect(useTerminalStore.getState().activeId).toBe('t7')
    expect(screen.queryByRole('group', { name: 'All terminals' })).toBeNull()
  })

  it('offers the first shell in one click when none is attached', async () => {
    useTerminalStore.setState({ loaded: true, terminals: [term({ id: 'a', title: 'other' }), term({ id: 'b', title: 'mine', sessionId: 's1' })] })
    render(<TerminalPanel sessionId="s1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Attach mine' }))
    expect(useTerminalStore.getState().activeId).toBe('b')
  })

  it('doesn’t carry another project’s shell into a session: it offers one in the session’s folder', async () => {
    useSessionStore.setState({ sessions: [{ id: 's1', agent: 'claude', cwd: '/w/proj', status: 'idle' }, { id: 's2', agent: 'claude', cwd: '/w/new', status: 'idle' }] })
    useTerminalStore.setState({ loaded: true, activeId: 'a', terminals: [term({ id: 'a', title: 'proj', cwd: '/w/proj', sessionId: 's1' })] })
    ;(api.openTerminal as Mock).mockResolvedValue(term({ id: 'n', title: 'new', cwd: '/w/new', sessionId: 's2' }))
    const { rerender } = render(<TerminalPanel sessionId="s1" />)
    expect(screen.getByTestId('terminal-view')).toBeInTheDocument()
    rerender(<TerminalPanel sessionId="s2" />)
    expect(screen.queryByTestId('terminal-view')).toBeNull()
    expect(screen.getByText(/No terminal in new\./)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Attach/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Open terminal in new' }))
    expect(api.openTerminal).toHaveBeenCalledWith({ sessionId: 's2' })
  })

  it('says a gone session folder takes no terminal, and offers none there', async () => {
    useSessionStore.setState({ sessions: [{ id: 'g', agent: 'claude', cwd: '/w/doomed', status: 'detached', folderGone: true }] })
    useTerminalStore.setState({ loaded: true, terminals: [term({ id: 'a', title: 'proj', cwd: '/w/proj' })] })
    render(<TerminalPanel sessionId="g" />)
    const gone = screen.getByRole('status', { name: 'Folder gone' })
    expect(gone).toHaveTextContent('Folder gone /w/doomed This folder no longer exists')
    expect(gone.textContent).not.toContain('·')
    expect(screen.queryByRole('button', { name: /Open terminal in/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New terminal in session folder' })).toBeNull()
    // Elsewhere is still one click away.
    await userEvent.click(screen.getByRole('button', { name: 'More terminals' }))
    expect(screen.getByRole('button', { name: 'Home folder' })).toBeInTheDocument()
  })

  it('says how many terminals a restart ended, in the dock and in terminal mode', () => {
    useTerminalStore.setState({ loaded: true, terminals: [], ended: 1 })
    const { unmount } = render(<TerminalPanel sessionId={null} />)
    expect(screen.getByRole('status', { name: 'Terminals ended' })).toHaveTextContent('1 terminal ended when go-chamber restarted')
    unmount()
    useTerminalStore.setState({ ended: 3 })
    render(<TerminalWorkspace sessions={[]} />)
    expect(screen.getByRole('status', { name: 'Terminals ended' })).toHaveTextContent('3 terminals ended when go-chamber restarted')
  })

  it('says a removed worktree takes no terminal either', () => {
    const worktree = { repo: '/src/app', path: '/wt/app/fix', branch: 'chamber/fix', base: 'abc', removed: true }
    useSessionStore.setState({ sessions: [{ id: 'w', agent: 'claude', cwd: '/wt/app/fix', status: 'detached', worktree }] })
    useTerminalStore.setState({ loaded: true, terminals: [] })
    render(<TerminalPanel sessionId="w" />)
    expect(screen.getByRole('status', { name: 'Worktree removed' })).toHaveTextContent('Worktree removed · no terminal opens in it')
    expect(screen.queryByText(/No terminals yet/)).toBeNull()
  })

  it('attaches another folder’s shell when it is picked', async () => {
    useSessionStore.setState({ sessions: [{ id: 's2', agent: 'claude', cwd: '/w/new', status: 'idle' }] })
    useTerminalStore.setState({ loaded: true, activeId: 'a', terminals: [term({ id: 'a', title: 'proj', cwd: '/w/proj' })] })
    render(<TerminalPanel sessionId="s2" />)
    expect(screen.queryByTestId('terminal-view')).toBeNull()
    await userEvent.click(screen.getByRole('tab', { name: /proj/ }))
    expect(screen.getByTestId('terminal-view')).toBeInTheDocument()
  })

  it('says shells are loading before the list arrives', () => {
    render(<TerminalPanel sessionId={null} />)
    expect(screen.getByRole('status')).toHaveTextContent('loading terminals…')
    expect(screen.getByRole('button', { name: 'New terminal in home folder' })).toBeInTheDocument()
  })
})
