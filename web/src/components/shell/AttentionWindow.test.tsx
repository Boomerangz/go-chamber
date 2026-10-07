import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resetStore, useSessionStore } from '../../stores/session'
import AttentionWindow, { AttentionPanel } from './AttentionWindow'
import { useAttention } from '../../stores/attention'
import * as api from '../../lib/api'

let frame: HTMLIFrameElement
let pip: Window
let requestWindow: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.spyOn(api, 'fetchEvents').mockResolvedValue([])
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
  expect(panel.getByText(/Updates paused/)).toBeInTheDocument()
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
  expect(await screen.findByRole('alert')).toHaveTextContent('Window denied')
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
  expect(screen.getByLabelText('Task elapsed')).toHaveTextContent('01:00')
  expect(screen.getByText('Running make test')).toBeInTheDocument()
  expect(screen.getByLabelText('Action elapsed')).toHaveTextContent('00:10')
  act(() => vi.advanceTimersByTime(2000))
  expect(screen.getByLabelText('Task elapsed')).toHaveTextContent('01:02')
  act(() => {
    const request = { id: 'r', sessionId: 's', kind: 'question' as const, state: 'pending' as const, title: 'Which approach?' }
    ingest({ sessionId: 's', seq: 3, type: 'request.opened', request }, 62000)
    useSessionStore.setState({ pendingRequests: [request] })
  })
  expect(screen.getByText('Waiting for you · 00:01')).toBeInTheDocument()
  act(() => {
    ingest({ sessionId: 's', seq: 4, type: 'turn.ended', result: { text: 'Fixed tests' } }, 64000)
    useSessionStore.setState({ pendingRequests: [], sessions: [{ id: 's', agent: 'codex', cwd: '/tmp/project', status: 'idle', title: 'Fix tests' }] })
  })
  await act(async () => {})
  expect(screen.getByText('Fixed tests')).toBeInTheDocument()
  act(() => vi.advanceTimersByTime(10000))
  expect(screen.getByLabelText('Task elapsed')).toHaveTextContent('01:03')
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss result' }))
  expect(screen.queryByText('Fixed tests')).toBeNull()
})

it('offers overview without PiP and returns to sessions', () => {
  vi.stubGlobal('documentPictureInPicture', undefined)
  useSessionStore.setState({ pane: 'overview', connection: 'offline' })
  render(<main><AttentionPanel standalone /></main>)
  expect(screen.getByRole('heading', { name: 'Overview' })).toBeVisible()
  expect(screen.getAllByRole('main')).toHaveLength(1)
  expect(screen.queryByText(/Keep the main/)).toBeNull()
  expect(screen.getByRole('status')).not.toHaveTextContent('main tab')
  fireEvent.click(screen.getByRole('button', { name: 'Sessions' }))
  expect(useSessionStore.getState().pane).toBe('sessions')
})
