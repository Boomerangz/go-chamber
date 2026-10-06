import { render, screen } from '@testing-library/react'
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
}

const state = (over: Partial<ReturnType<typeof useDiagnostics>>) =>
  vi.mocked(useDiagnostics).mockReturnValue({ client: diagnostics(), server: null, error: null, socketStatus: 'online', ...over })

describe('DiagnosticsPage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('only mentions the last snapshot when there is one', () => {
    state({ error: 'HTTP 502' })
    const first = render(<DiagnosticsPage />)
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 502')
    expect(screen.getByRole('alert')).not.toHaveTextContent('last successful')
    first.unmount()
    state({ error: 'HTTP 502', server })
    render(<DiagnosticsPage />)
    expect(screen.getByRole('alert')).toHaveTextContent('The last successful server snapshot is shown below.')
  })

  it('shows uptime in hours and minutes and connection states as marks', () => {
    state({ server, socketStatus: 'reconnecting' })
    const { container } = render(<DiagnosticsPage />)
    expect(screen.getByText('1h 12m')).toBeInTheDocument()
    expect(screen.getByText('reconnecting')).toHaveAttribute('data-mark', 'dashed')
    expect(container.querySelector('h2')).toHaveTextContent('Diagnostics')
  })
})
