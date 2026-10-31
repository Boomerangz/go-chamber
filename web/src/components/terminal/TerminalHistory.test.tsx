import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import TerminalHistory from './TerminalHistory'

afterEach(() => vi.unstubAllGlobals())
it('reads and searches history separately, preserves line IDs and marks eviction', async () => {
  const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('q=needle')
    ? {lines: [{id: 9, text: 'needle'}], nextBefore: 0, evictedThrough: 4}
    : url.includes('before=9')
      ? {lines: [{id: 8, text: '<clipboard is plain text>'}], nextBefore: 0, evictedThrough: 4}
      : {lines: [{id: 9, text: 'newest'}], nextBefore: 9, evictedThrough: 4})))
  vi.stubGlobal('fetch', fetcher)
  render(<TerminalHistory id="t" onClose={() => {}} />)
  await screen.findByText('newest')
  expect(screen.getByText(/evicted/i)).toBeVisible()
  fireEvent.click(screen.getByRole('button', {name: 'Load older'}))
  await screen.findByText('<clipboard is plain text>')
  expect(screen.getByText('newest')).toBeVisible()
  fireEvent.change(screen.getByLabelText('Search terminal history'), {target: {value: 'needle'}})
  await screen.findByText('needle')
  await waitFor(() => expect(screen.queryByText('newest')).toBeNull())
})
