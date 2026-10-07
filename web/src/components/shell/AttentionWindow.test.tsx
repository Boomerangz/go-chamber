import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { resetStore, useSessionStore } from '../../stores/session'
import AttentionWindow, { AttentionPanel } from './AttentionWindow'
import { useAttention } from '../../stores/attention'
import * as api from '../../lib/api'
import { useNotices } from '../../stores/notices'

let frame: HTMLIFrameElement
let pip: Window
let requestWindow: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.spyOn(api, 'fetchEvents').mockResolvedValue([])
  vi.spyOn(api, 'markSeen').mockResolvedValue({ id: 's', agent: 'claude', cwd: '/', status: 'idle' })
  useNotices.setState({ notices: [] })
  resetStore()
  useSessionStore.setState({ connection: 'online', requestsStatus: 'ready', sessionsStatus: 'ready' })
  frame = document.createElement('iframe')
  document.body.append(frame)
  pip = frame.contentWindow!
  vi.spyOn(pip, 'close').mockImplementation(() => {})
  requestWindow = vi.fn().mockResolvedValue(pip)
  vi.stubGlobal('documentPictureInPicture', { requestWindow })
})
afterEach(() => { frame.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks() })

it('explains unsupported browsers', () => {
  vi.stubGlobal('documentPictureInPicture', undefined)
  render(<AttentionWindow />)
  expect(screen.getByRole('button', { name: 'Open floating panel' })).toBeDisabled()
})

it('opens a live panel, answers in place, and resets when closed', async () => {
  const respond = vi.fn().mockResolvedValue(true)
  useSessionStore.setState({ respond, sessions: [{ id: 's', agent: 'claude', cwd: '/tmp/project', status: 'running' }],
    pendingRequests: [{ id: 'r', sessionId: 's', kind: 'permission', state: 'pending', title: 'Run tests' }] })
  render(<AttentionWindow />)
  fireEvent.click(screen.getByRole('button', { name: 'Open floating panel' }))
  const panel = within(pip.document.body)
  await panel.findByText('Run tests')
  expect(requestWindow).toHaveBeenCalledWith({ width: 420, height: 560 })
  fireEvent.click(panel.getByRole('button', { name: 'Allow' }))
  await act(async () => {})
  expect(respond).toHaveBeenCalledWith('s', 'r', { behavior: 'allow' })
  act(() => useSessionStore.setState({ pendingRequests: [], connection: 'offline' }))
  expect(pip.document.querySelector('.attention-panel > .live-strip')).toHaveTextContent(/live updates paused/)
  expect(panel.queryByText('Run tests')).toBeNull()
  act(() => pip.dispatchEvent(new Event('pagehide')))
  expect(screen.getByRole('button', { name: 'Open floating panel' })).toHaveAttribute('aria-pressed', 'false')
})

it('copies styles and closes the child on unmount', async () => {
  const style = document.createElement('style')
  style.textContent = '.pip-test { color: red; }'
  document.head.append(style)
  const { unmount } = render(<AttentionWindow />)
  fireEvent.click(screen.getByRole('button', { name: 'Open floating panel' }))
  await within(pip.document.body).findByText('Keep the main go-chamber tab open to receive updates.')
  expect(pip.document.head.textContent).toContain('.pip-test')
  unmount()
  expect(pip.close).toHaveBeenCalled()
  style.remove()
})

it('reports a rejected opening and allows another attempt', async () => {
  requestWindow.mockRejectedValueOnce(new Error('Window denied'))
  render(<AttentionWindow />)
  fireEvent.click(screen.getByRole('button', { name: 'Open floating panel' }))
  await act(async () => {})
  // The reason goes to a notice, not into the top bar.
  expect(useNotices.getState().notices).toMatchObject([{ kind: 'error', title: "Couldn't open the floating panel", text: 'Window denied' }])
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Open floating panel' }))
  await within(pip.document.body).findByText('Keep the main go-chamber tab open to receive updates.')
})

it('returns to a session without opening a second panel', async () => {
  const selectSession = vi.fn().mockResolvedValue(undefined)
  const focus = vi.spyOn(window, 'focus').mockImplementation(() => {})
  vi.spyOn(pip, 'focus').mockImplementation(() => {})
  useSessionStore.setState({ selectSession, sessions: [{ id: 's', agent: 'codex', cwd: '/tmp/project', status: 'running', title: 'Fix tests' }] })
  render(<AttentionWindow />)
  const open = screen.getByRole('button', { name: 'Open floating panel' })
  fireEvent.click(open)
  fireEvent.click(await within(pip.document.body).findByRole('button', { name: /Fix tests/ }))
  expect(selectSession).toHaveBeenCalledWith('s')
  expect(focus).toHaveBeenCalled()
  fireEvent.click(open)
  expect(requestWindow).toHaveBeenCalledTimes(1)
  expect(pip.focus).toHaveBeenCalled()
})

it('closes a delayed window if the component has gone away', async () => {
  let resolve!: (win: Window) => void
  requestWindow.mockReturnValue(new Promise<Window>((done) => { resolve = done }))
  const { unmount } = render(<AttentionWindow />)
  fireEvent.click(screen.getByRole('button', { name: 'Open floating panel' }))
  unmount()
  await act(async () => resolve(pip))
  expect(pip.close).toHaveBeenCalled()
})

it('shows the task clock, current action, waiting time and retained result', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(61000)
  useSessionStore.setState({ sessions: [{ id: 's', agent: 'codex', cwd: '/tmp/project', status: 'running', title: 'Fix tests', activeAt: new Date(1000).toISOString() }] })
  const ingest = useAttention.getState().ingest
  ingest({ sessionId: 's', seq: 1, type: 'turn.started' }, 1000)
  ingest({ sessionId: 's', seq: 2, type: 'item.updated', item: { id: 't', sessionId: 's', kind: 'command', status: 'streaming', text: 'make test' } }, 51000)
  render(<AttentionPanel />)
  await act(async () => {})
  expect(screen.getByLabelText('Task elapsed')).toHaveTextContent('1:00')
  expect(screen.getByText('Running make test')).toBeInTheDocument()
  expect(screen.getByLabelText('Action elapsed')).toHaveTextContent('0:10')
  act(() => vi.advanceTimersByTime(2000))
  expect(screen.getByLabelText('Task elapsed')).toHaveTextContent('1:02')
  act(() => {
    const request = { id: 'r', sessionId: 's', kind: 'question' as const, state: 'pending' as const, title: 'Which approach?' }
    ingest({ sessionId: 's', seq: 3, type: 'request.opened', request }, 62000)
    useSessionStore.setState({ pendingRequests: [request] })
  })
  expect(screen.getByText('Waiting for you · answer above')).toBeInTheDocument()
  expect(screen.getByLabelText('Waiting elapsed')).toHaveTextContent('0:01')
  act(() => {
    ingest({ sessionId: 's', seq: 4, type: 'turn.ended', result: { text: 'Fixed tests' } }, 64000)
    useSessionStore.setState({ pendingRequests: [], sessions: [{ id: 's', agent: 'codex', cwd: '/tmp/project', status: 'idle', title: 'Fix tests', endedAt: new Date(64000).toISOString() }] })
  })
  await act(async () => {})
  expect(screen.getByText('Fixed tests')).toBeInTheDocument()
  act(() => vi.advanceTimersByTime(10000))
  expect(screen.getByLabelText('Task elapsed')).toHaveTextContent('1:03')
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss result' }))
  expect(screen.queryByText('Fixed tests')).toBeNull()
  expect(api.markSeen).toHaveBeenCalledWith('s')
})

it('offers overview without PiP and returns to sessions', () => {
  vi.stubGlobal('documentPictureInPicture', undefined)
  useSessionStore.setState({ pane: 'overview', connection: 'offline' })
  render(<main><AttentionPanel standalone /></main>)
  expect(screen.getByRole('heading', { name: 'Overview' })).toBeVisible()
  expect(screen.getAllByRole('main')).toHaveLength(1)
  expect(screen.queryByText(/Keep the main/)).toBeNull()
  expect(document.querySelector('.attention-panel > .live-strip')).toHaveTextContent(/live updates paused/)
  expect(screen.queryByText(/main tab/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Sessions' }))
  expect(useSessionStore.getState().pane).toBe('sessions')
})

const ended = (over: Partial<api.Session> = {}): api.Session => ({ id: 's', agent: 'claude', cwd: '/tmp/project', status: 'idle', title: 'Ship it',
  activeAt: new Date(0).toISOString(), endedAt: new Date(90_000).toISOString(), ...over })

it("shows the server's unseen results after a reload, and Dismiss marks the session seen", async () => {
  vi.mocked(api.fetchEvents).mockResolvedValue([
    { sessionId: 's', seq: 1, type: 'turn.started' },
    { sessionId: 's', seq: 2, type: 'turn.ended', result: { isError: true, error: 'Tests failed' } },
  ])
  useSessionStore.setState({ sessions: [ended({ seen: { at: new Date(10_000).toISOString() } }), ended({ id: 'read', title: 'Read already', seen: { at: new Date(100_000).toISOString() } })] })
  render(<AttentionPanel standalone />)
  expect(await screen.findByText('Tests failed')).toBeInTheDocument()
  expect(screen.getByText('Failed')).toBeInTheDocument()
  // The turn's length comes from the server when this page didn't watch it.
  expect(screen.getByLabelText('Task elapsed')).toHaveTextContent('1:30')
  expect(screen.queryByText('Read already')).toBeNull()
  expect(api.fetchEvents).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss result' }))
  expect(screen.queryByText('Tests failed')).toBeNull()
  expect(api.markSeen).toHaveBeenCalledWith('s')
})

it('drops a result the owner looked at on another device', async () => {
  useSessionStore.setState({ sessions: [ended()] })
  render(<AttentionPanel standalone />)
  expect(await screen.findByText('Ship it')).toBeInTheDocument()
  act(() => useSessionStore.setState({ sessions: [ended({ seen: { at: new Date(95_000).toISOString() } })] }))
  expect(screen.queryByText('Ship it')).toBeNull()
  expect(screen.getByText('No active tasks or new results')).toHaveClass('attention-empty')
})

it('opens a result and marks it seen; a refused mark brings the card back with a notice', async () => {
  const selectSession = vi.fn().mockResolvedValue(undefined)
  useSessionStore.setState({ selectSession, sessions: [ended()] })
  vi.mocked(api.markSeen).mockRejectedValueOnce(new Error('offline'))
  render(<AttentionPanel standalone />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'Open result' }))
  expect(selectSession).toHaveBeenCalledWith('s')
  expect(api.markSeen).toHaveBeenCalledWith('s')
  await act(async () => {})
  expect(screen.getByRole('button', { name: 'Open result' })).toBeInTheDocument()
  expect(useNotices.getState().notices).toMatchObject([{ title: "Couldn't mark the result seen", text: 'offline' }])
})

it('follows sessions live instead of refetching every transcript on each change', async () => {
  useSessionStore.setState({ sessions: [{ id: 's', agent: 'claude', cwd: '/p', status: 'running' }, { id: 't', agent: 'claude', cwd: '/q', status: 'running' }] })
  render(<AttentionPanel />)
  await act(async () => {})
  expect(api.fetchEvents).toHaveBeenCalledTimes(2)
  for (let i = 0; i < 5; i++) {
    act(() => useSessionStore.setState({ sessions: [{ id: 's', agent: 'claude', cwd: '/p', status: 'running', activeAt: new Date(i).toISOString() }, { id: 't', agent: 'claude', cwd: '/q', status: i % 2 ? 'idle' : 'running', endedAt: new Date(i).toISOString() }] }))
    await act(async () => {})
  }
  expect(api.fetchEvents).toHaveBeenCalledTimes(2)
  // Back from a dropped socket: each followed session catches up once.
  act(() => useSessionStore.setState({ connection: 'offline' }))
  act(() => useSessionStore.setState({ connection: 'online' }))
  await act(async () => {})
  expect(api.fetchEvents).toHaveBeenCalledTimes(4)
})

it('says the session list is loading, then failed with a Retry, and hides counts until it loads', () => {
  const loadSessions = vi.fn().mockResolvedValue(undefined)
  useSessionStore.setState({ sessionsStatus: 'loading', loadSessions })
  const { rerender } = render(<AttentionPanel standalone />)
  expect(screen.getByRole('status')).toHaveTextContent('loading sessions…')
  expect(screen.queryByText(/running ·/)).toBeNull()
  act(() => useSessionStore.setState({ sessionsStatus: 'error', sessionsError: 'boom' }))
  rerender(<AttentionPanel standalone />)
  expect(screen.getAllByRole('alert').some((el) => el.textContent?.includes("Couldn't load sessions: boom"))).toBe(true)
  expect(screen.queryByText(/running ·/)).toBeNull()
  fireEvent.click(screen.getAllByRole('button', { name: 'Retry' }).at(-1)!)
  expect(loadSessions).toHaveBeenCalled()
})

it('counts what waits as the inbox does, cut-off questions included', () => {
  useSessionStore.setState({ sessions: [ended({ status: 'interrupted', interruption: { reason: 'restart', withRequest: true } as api.Session['interruption'] })] })
  render(<AttentionPanel standalone />)
  expect(screen.getByText('0 running · 1 waiting')).toBeInTheDocument()
})

it('counts a running session that waits on the owner as waiting, not also running', () => {
  useSessionStore.setState({
    sessions: [
      { id: 'a', agent: 'claude', cwd: '/tmp/a', status: 'running' },
      { id: 'b', agent: 'claude', cwd: '/tmp/b', status: 'running' },
      { id: 'c', agent: 'claude', cwd: '/tmp/c', status: 'running' },
    ],
    pendingRequests: [
      { id: 'r1', sessionId: 'a', kind: 'permission', state: 'pending', title: 'Run tests' },
      { id: 'r2', sessionId: 'b', kind: 'question', state: 'pending', title: 'Which one?' },
    ],
  })
  render(<AttentionPanel standalone />)
  expect(screen.getByText('1 running · 2 waiting')).toBeInTheDocument()
})

it('says why activity failed to load, with a Retry', async () => {
  vi.mocked(api.fetchEvents).mockRejectedValueOnce(new Error('offline')).mockResolvedValue([])
  useSessionStore.setState({ sessions: [{ id: 's', agent: 'claude', cwd: '/p', status: 'running', title: 'Busy' }] })
  render(<AttentionPanel standalone />)
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent("Couldn't load activity: offline")
  fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
  await act(async () => {})
  expect(screen.queryByRole('alert')).toBeNull()
})

it('opens on the first waiting row, so its keys answer it', async () => {
  const request = { id: 'r', sessionId: 's', kind: 'permission' as const, state: 'pending' as const, title: 'Run tests' }
  useSessionStore.setState({ sessions: [{ id: 's', agent: 'claude', cwd: '/p', status: 'running', title: 'Busy' }], pendingRequests: [request] })
  const toggle = document.createElement('button')
  document.body.append(toggle)
  onTestFinished(() => toggle.remove())
  toggle.focus()
  render(<AttentionPanel standalone />)
  await act(async () => {})
  expect(document.activeElement).toHaveClass('tray-row')
  expect(document.activeElement).toHaveAttribute('data-key', expect.stringMatching(/^s\//))
})

it('leaves focus alone with nothing waiting, and in the floating panel', async () => {
  const request = { id: 'r', sessionId: 's', kind: 'permission' as const, state: 'pending' as const, title: 'Run tests' }
  useSessionStore.setState({ sessions: [{ id: 's', agent: 'claude', cwd: '/p', status: 'running', title: 'Busy' }] })
  const view = render(<AttentionPanel standalone />)
  await act(async () => {})
  expect(document.activeElement).not.toHaveClass('tray-row')
  view.unmount()
  useSessionStore.setState({ pendingRequests: [request] })
  render(<AttentionPanel />)
  await act(async () => {})
  expect(document.activeElement).not.toHaveClass('tray-row')
})

it('takes the first row that arrives once, and not again after the owner moved on', async () => {
  const request = (id: string) => ({ id, sessionId: 's', kind: 'permission' as const, state: 'pending' as const, title: `Run ${id}` })
  useSessionStore.setState({ sessions: [{ id: 's', agent: 'claude', cwd: '/p', status: 'running', title: 'Busy' }] })
  render(<AttentionPanel standalone />)
  await act(async () => {})
  act(() => useSessionStore.setState({ pendingRequests: [request('r1')] }))
  expect(document.activeElement).toHaveClass('tray-row')
  ;(document.activeElement as HTMLElement).blur()
  act(() => useSessionStore.setState({ pendingRequests: [request('r1'), request('r2')] }))
  expect(document.activeElement).not.toHaveClass('tray-row')
})

it('shows one clock when the wait began with the task', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(12_000)
  const request = { id: 'r', sessionId: 's', kind: 'permission' as const, state: 'pending' as const, title: 'Run tests', openedAt: new Date(11_000).toISOString() }
  useSessionStore.setState({ sessions: [{ id: 's', agent: 'claude', cwd: '/p', status: 'running', title: 'Busy', activeAt: new Date(10_000).toISOString() }], pendingRequests: [request] })
  for (const standalone of [true, false]) {
    const view = render(<AttentionPanel standalone={standalone} />)
    await act(async () => {})
    expect(screen.getByLabelText('Task elapsed')).toHaveTextContent('0:02')
    expect(screen.getByRole('button', { name: /Waiting for you/ })).toHaveTextContent(/^Waiting for you · answer above$/)
    expect(screen.queryByLabelText('Waiting elapsed')).toBeNull()
    view.unmount()
  }
})

it("times a wait from the request's own opening and points to it in the inbox", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(65_000)
  const request = { id: 'r', sessionId: 's', kind: 'permission' as const, state: 'pending' as const, title: 'Run tests', openedAt: new Date(5_000).toISOString() }
  useSessionStore.setState({ sessions: [{ id: 's', agent: 'claude', cwd: '/p', status: 'running', title: 'Busy' }], pendingRequests: [request] })
  render(<AttentionPanel standalone />)
  await act(async () => {})
  expect(screen.getByLabelText('Waiting elapsed')).toHaveTextContent('1:00')
  fireEvent.click(screen.getByRole('button', { name: /Waiting for you/ }))
  expect(document.activeElement).toHaveClass('tray-row')
})
