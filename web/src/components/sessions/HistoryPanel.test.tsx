import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import HistoryPanel from './HistoryPanel'
import * as api from '../../lib/api'
import { resetStore, useSessionStore } from '../../stores/session'

vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof import('../../lib/api')>()),
  listHistory: vi.fn(),
  importHistory: vi.fn(),
  getSession: vi.fn(),
  fetchEvents: vi.fn(),
}))

const external: api.ExternalSession[] = [
  { agent: 'claude', nativeId: 'c1', cwd: '/src/app', title: 'Fix the flaky test', updatedAt: '2026-09-27T10:00:00Z' },
  { agent: 'codex', nativeId: 't1', cwd: '/src/site', title: 'Tidy the README', updatedAt: '2026-09-26T10:00:00Z' },
]

beforeEach(() => {
  vi.clearAllMocks()
  resetStore()
  vi.mocked(api.listHistory).mockResolvedValue(external)
})

async function open() {
  render(<HistoryPanel />)
  await userEvent.click(screen.getByText('History'))
  await screen.findByText('Fix the flaky test')
}

describe('HistoryPanel', () => {
  it('lists conversations recorded outside go-chamber once opened', async () => {
    render(<HistoryPanel />)
    expect(api.listHistory).not.toHaveBeenCalled()
    await userEvent.click(screen.getByText('History'))
    expect(await screen.findByText('Fix the flaky test')).toBeInTheDocument()
    expect(screen.getByText('Tidy the README')).toBeInTheDocument()
    expect(screen.getByText('/src/site')).toBeInTheDocument()
  })

  it('says why the list failed, in the words of its label, with Retry beside it', async () => {
    vi.mocked(api.listHistory).mockRejectedValueOnce(new Error('permission denied'))
    render(<HistoryPanel />)
    await userEvent.click(screen.getByText('History'))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent("Couldn't load CLI sessions: permission denied")
    expect(alert.querySelector('button')).toHaveTextContent('Retry')
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Fix the flaky test')).toBeInTheDocument()
  })

  it('filters by title and folder', async () => {
    await open()
    await userEvent.type(screen.getByLabelText('Filter history'), 'site')
    expect(screen.queryByText('Fix the flaky test')).not.toBeInTheDocument()
    expect(screen.getByText('Tidy the README')).toBeInTheDocument()
  })

  it('imports a conversation and opens it', async () => {
    const snap: api.Session = { id: 's9', agent: 'codex', cwd: '/src/site', status: 'detached', nativeId: 't1', title: 'Tidy the README' }
    vi.mocked(api.importHistory).mockResolvedValue(snap)
    vi.mocked(api.getSession).mockResolvedValue(snap)
    vi.mocked(api.fetchEvents).mockResolvedValue([])
    await open()
    await userEvent.click(screen.getByRole('button', { name: /Tidy the README/ }))
    expect(api.importHistory).toHaveBeenCalledWith('codex', 't1')
    await waitFor(() => expect(useSessionStore.getState().activeId).toBe('s9'))
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toContain('s9')
    expect(screen.queryByText('Tidy the README')).not.toBeInTheDocument()
  })

  it('says when there is nothing to import', async () => {
    vi.mocked(api.listHistory).mockResolvedValue([])
    render(<HistoryPanel />)
    await userEvent.click(screen.getByText('History'))
    expect(await screen.findByText(/No other CLI sessions/)).toBeInTheDocument()
  })

  it('shows a failed load', async () => {
    vi.mocked(api.listHistory).mockRejectedValue(new Error('codex is not installed'))
    render(<HistoryPanel />)
    await userEvent.click(screen.getByText('History'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/codex is not installed/)
  })

  it('keeps a conversation that failed to open, with the reason under it', async () => {
    vi.mocked(api.importHistory).mockRejectedValue(new Error('thread is gone'))
    await open()
    await userEvent.click(screen.getByRole('button', { name: /Tidy the README/ }))
    expect(await screen.findByText("Couldn't open the CLI session: thread is gone")).toHaveClass('error')
    expect(screen.getByRole('button', { name: /Tidy the README/ })).toBeEnabled()
  })

  it('reloads the list each time it opens', async () => {
    await open()
    await userEvent.click(screen.getByText('History'))
    vi.mocked(api.listHistory).mockResolvedValue([external[0]])
    await userEvent.click(screen.getByText('History'))
    await waitFor(() => expect(screen.queryByText('Tidy the README')).toBeNull())
    expect(api.listHistory).toHaveBeenCalledTimes(2)
  })

  it('says it is refreshing when reopened over an old list', async () => {
    await open()
    await userEvent.click(screen.getByText('History'))
    let finish: (l: api.ExternalSession[]) => void = () => {}
    vi.mocked(api.listHistory).mockImplementationOnce(() => new Promise((r) => (finish = r)))
    await userEvent.click(screen.getByText('History'))
    expect(screen.getByText('refreshing…')).toBeInTheDocument()
    expect(screen.getByText('Fix the flaky test')).toBeInTheDocument()
    finish(external)
    await waitFor(() => expect(screen.queryByText('refreshing…')).toBeNull())
  })

  it('retries a failed load', async () => {
    vi.mocked(api.listHistory).mockRejectedValueOnce(new Error('codex is not installed'))
    render(<HistoryPanel />)
    await userEvent.click(screen.getByText('History'))
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Fix the flaky test')).toBeInTheDocument()
  })

  it('says when the filter matches nothing', async () => {
    await open()
    await userEvent.type(screen.getByLabelText('Filter history'), 'zzz')
    expect(screen.getByText('No matching CLI sessions')).toBeInTheDocument()
  })

  it('says what History holds, and that opening one moves it into the sessions', async () => {
    render(<HistoryPanel />)
    expect(screen.getByText('History').closest('summary')).toHaveTextContent('sessions started in the CLI')
    await userEvent.click(screen.getByText('History'))
    await screen.findByText('Fix the flaky test')
    expect(screen.getByText(/Opening one moves it to your sessions/)).toHaveClass('history-note')
    // the rows sit in the sidebar's gutter, like Archived
    expect(document.querySelector('ul.sessions')).toHaveClass('history-list')
  })

  it('labels the section like the rest of the sidebar, with a drawn chevron', () => {
    render(<HistoryPanel />)
    const summary = screen.getByText('History').closest('summary')!
    expect(summary).toHaveClass('section-title')
    expect(summary.querySelector('svg')).not.toBeNull()
  })
})
