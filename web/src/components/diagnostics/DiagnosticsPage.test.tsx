import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useNotices } from '../../stores/notices'
import { useTerminalStore } from '../../stores/terminals'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { diagnostics } from '../../lib/diagnostics'
import DiagnosticsPage from './DiagnosticsPage'
import { useDiagnostics, type ServerDiagnostics } from './useDiagnostics'

vi.mock('./useDiagnostics', () => ({ useDiagnostics: vi.fn() }))

const server: ServerDiagnostics = {
  uptimeSeconds: 3600 + 12 * 60,
  goroutines: 10,
  heapBytes: 1024,
  events: { published: 1, persistCalls: 1, persistErrors: 0, persistMeanMs: 1, persistMaxMs: 1, lockWaitMeanMs: 1, lockWaitMaxMs: 1 },
  terminals: [],
  clis: [],
}

const state = (over: Partial<ReturnType<typeof useDiagnostics>>) =>
  vi.mocked(useDiagnostics).mockReturnValue({ client: diagnostics(), server: null, error: null, socketStatus: 'online', retry: vi.fn(), ...over })

describe('DiagnosticsPage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows where each agent CLI is, or how to install a missing one', () => {
    state({
      server: {
        ...server,
        clis: [
          { agent: 'claude', found: true, path: '/usr/local/bin/claude' },
          { agent: 'codex', found: false, hint: 'npm install -g @openai/codex' },
        ],
      },
    })
    render(<DiagnosticsPage />)
    const section = screen.getByRole('region', { name: 'Server diagnostics' })
    expect(section).toHaveTextContent('Claude Code CLI/usr/local/bin/claude')
    expect(section).toHaveTextContent('Codex CLInot found on PATH · npm install -g @openai/codex')
  })

  it('says what failed and why, with a Retry, and only mentions the last snapshot when there is one', async () => {
    const retry = vi.fn()
    state({ error: '502 Bad Gateway', retry })
    const first = render(<DiagnosticsPage />)
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load the server diagnostics: 502 Bad Gateway")
    expect(screen.queryByText(/last successful/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledOnce()
    first.unmount()
    state({ error: '502 Bad Gateway', server })
    render(<DiagnosticsPage />)
    expect(screen.getByText('The last successful server snapshot is shown below.')).toBeInTheDocument()
  })

  it('copies the report', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    state({ server })
    render(<DiagnosticsPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Copy report' }))
    expect(JSON.parse((writeText.mock.calls[0] as unknown as [string])[0])).toMatchObject({ server: { goroutines: 10 } })
    expect(useNotices.getState().notices.at(-1)).toMatchObject({ kind: 'info', text: 'Copied the report' })
    vi.unstubAllGlobals()
  })

  it('names the report when it could not copy it', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) } })
    state({ server })
    render(<DiagnosticsPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Copy report' }))
    expect(useNotices.getState().notices.at(-1)).toMatchObject({ kind: 'error', title: "Couldn't copy the report" })
    vi.unstubAllGlobals()
  })

  it('grades each metric and says what to try when it is not quiet', () => {
    const client = diagnostics()
    client.metrics.http = { ...client.metrics.http, p95: 900, count: 3, samples: 3 }
    client.metrics.ws = { ...client.metrics.ws, p95: 10, count: 3, samples: 3 }
    state({ client })
    render(<DiagnosticsPage />)
    const http = screen.getByRole('heading', { name: 'HTTP round trip' }).closest('article')!
    expect(http).toHaveAttribute('data-level', 'bad')
    expect(http).toHaveTextContent(/bad.*check the host/)
    const ws = screen.getByRole('heading', { name: 'WebSocket round trip' }).closest('article')!
    expect(ws).toHaveAttribute('data-level', 'quiet')
  })

  it('names terminals by title or folder, never by id, and labels their cells', () => {
    useTerminalStore.setState({ terminals: [{ id: 'abc', title: '', cwd: '/srv/api', shell: 'sh', status: 'running', exitCode: 0, createdAt: '' }] })
    state({ server: { ...server, terminals: [{ id: 'abc', queuedBytes: 0, outputBytes: 0, laggedClients: 0, clients: 1 }] } })
    render(<DiagnosticsPage />)
    const row = screen.getByRole('rowheader', { name: 'api' })
    expect(row.closest('tr')!.querySelector('td[data-label="Clients"]')).toHaveTextContent('1')
  })

  it('folds terminals with nothing measured into one line', () => {
    const shell = (id: string, title: string) => ({ id, title, cwd: '/srv/repo', shell: 'sh', status: 'running' as const, exitCode: 0, createdAt: '' })
    useTerminalStore.setState({ terminals: [shell('a', 'repo'), shell('b', 'repo 2'), shell('c', 'logs')] })
    state({
      server: {
        ...server,
        terminals: [
          { id: 'a', queuedBytes: 0, outputBytes: 0, laggedClients: 0, clients: 0 },
          { id: 'b', queuedBytes: 0, outputBytes: 0, laggedClients: 0, clients: 0 },
          { id: 'c', queuedBytes: 0, outputBytes: 0, laggedClients: 0, clients: 1 },
        ],
      },
    })
    render(<DiagnosticsPage />)
    expect(screen.getByRole('rowheader', { name: 'logs' })).toBeInTheDocument()
    expect(screen.queryByRole('rowheader', { name: 'repo' })).toBeNull()
    expect(screen.getByText('Not attached, nothing measured: repo, repo 2')).toBeInTheDocument()
  })

  it('shows uptime in hours and minutes and connection states as marks', () => {
    state({ server, socketStatus: 'reconnecting' })
    const { container } = render(<DiagnosticsPage />)
    expect(screen.getByText('1h 12m')).toBeInTheDocument()
    expect(screen.getByText('reconnecting')).toHaveAttribute('data-mark', 'dashed')
    expect(container.querySelector('h2')).toHaveTextContent('Diagnostics')
  })
})
