import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../lib/api'
import Attachments from './Attachments'
import { useAttachments } from './useAttachments'

vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof import('../../lib/api')>()),
  uploadImage: vi.fn(),
}))

let n = 0
beforeEach(() => {
  vi.clearAllMocks()
  n = 0
  vi.mocked(api.uploadImage).mockImplementation(async () => ({ id: `img${++n}.png`, mimeType: 'image/png' }))
})

const png = (name = 'a.png') => new File(['x'], name, { type: 'image/png' })

let latest: ReturnType<typeof useAttachments>
function Harness({ sessionId = 's1' }: { sessionId?: string }) {
  const state = useAttachments(sessionId)
  useEffect(() => {
    latest = state
  })
  return (
    <form aria-label="composer" {...state.dropProps}>
      <Attachments state={state} />
    </form>
  )
}

describe('Attachments', () => {
  it('uploads picked images, shows them and removes one', async () => {
    render(<Harness />)
    await userEvent.upload(screen.getByLabelText('attach images'), [png('a.png'), png('b.png')])
    expect(await screen.findAllByRole('img')).toHaveLength(2)
    expect(screen.getAllByRole('img')[0]).toHaveAttribute('src', '/api/sessions/s1/images/img1.png')
    expect(latest.ids).toEqual(['img1.png', 'img2.png'])
    await userEvent.click(screen.getByRole('button', { name: 'remove a.png' }))
    expect(latest.ids).toEqual(['img2.png'])
    act(() => latest.clear())
    expect(screen.queryAllByRole('img')).toHaveLength(0)
  })

  it('takes pasted and dropped images, and ignores other files', async () => {
    render(<Harness />)
    const form = screen.getByRole('form', { name: 'composer' })
    fireEvent.paste(form, { clipboardData: { files: [png('pasted.png')] } })
    await screen.findByRole('img')
    fireEvent.drop(form, { dataTransfer: { files: [png('dropped.png'), new File(['t'], 'notes.txt', { type: 'text/plain' })] } })
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2))
    expect(api.uploadImage).toHaveBeenCalledTimes(2)
  })

  it('reports a failed upload', async () => {
    vi.mocked(api.uploadImage).mockRejectedValue(new Error('image is larger than 10 MB'))
    render(<Harness />)
    await userEvent.upload(screen.getByLabelText('attach images'), png())
    expect(await screen.findByRole('alert')).toHaveTextContent('image is larger than 10 MB')
    expect(latest.ids).toEqual([])
  })
})
