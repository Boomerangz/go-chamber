import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../lib/api'
import Attachments from './Attachments'
import { useAttachments } from './useAttachments'
import { resetDrafts } from '../../stores/drafts'

vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof import('../../lib/api')>()),
  uploadImage: vi.fn(),
}))

let n = 0
beforeEach(() => {
  vi.clearAllMocks()
  resetDrafts()
  n = 0
  vi.mocked(api.uploadImage).mockImplementation(async () => ({ id: `img${++n}.png`, mimeType: 'image/png' }))
})

const png = (name = 'a.png') => new File(['x'], name, { type: 'image/png' })

let latest: ReturnType<typeof useAttachments>
function Harness({ sessionId = 's1', locked = false }: { sessionId?: string; locked?: boolean }) {
  const state = useAttachments(sessionId, locked)
  useEffect(() => {
    latest = state
  })
  return (
    <form aria-label="composer" {...state.dropProps}>
      <Attachments state={state} locked={locked} />
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
    expect(await screen.findByRole('alert')).toHaveTextContent('a.png: image is larger than 10 MB')
    expect(latest.ids).toEqual([])
    await userEvent.click(screen.getByRole('button', { name: 'dismiss a.png' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows a placeholder per file while it uploads', async () => {
    let finish: (v: api.UploadedImage) => void = () => {}
    vi.mocked(api.uploadImage).mockImplementationOnce(() => new Promise((r) => (finish = r)))
    render(<Harness />)
    await userEvent.upload(screen.getByLabelText('attach images'), png('big.png'))
    const placeholder = screen.getByLabelText('uploading big.png')
    expect(placeholder).toHaveAttribute('title', 'big.png')
    expect(latest.uploading).toBe(true)
    await act(async () => finish({ id: 'big.png', mimeType: 'image/png' }))
    expect(screen.queryByLabelText('uploading big.png')).toBeNull()
    expect(latest.uploading).toBe(false)
    expect(screen.getByRole('img')).toHaveAttribute('alt', 'big.png')
  })

  it('names a dropped file that is not an image', async () => {
    render(<Harness />)
    fireEvent.drop(screen.getByRole('form', { name: 'composer' }), {
      dataTransfer: { files: [new File(['t'], 'x.pdf', { type: 'application/pdf' })] },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('only images can be attached: x.pdf')
    expect(api.uploadImage).not.toHaveBeenCalled()
  })

  it('says where to drop while dragging over the composer', () => {
    render(<Harness />)
    const form = screen.getByRole('form', { name: 'composer' })
    fireEvent.dragEnter(form, { dataTransfer: { types: ['Files'] } })
    expect(latest.dragging).toBe(true)
    expect(screen.getByText('Drop images to attach')).toBeInTheDocument()
    fireEvent.dragLeave(form)
    expect(latest.dragging).toBe(false)
  })

  it('keeps images of a session across remounts', async () => {
    const { unmount } = render(<Harness />)
    await userEvent.upload(screen.getByLabelText('attach images'), png('kept.png'))
    await screen.findByRole('img')
    unmount()
    render(<Harness />)
    expect(screen.getByRole('img')).toHaveAttribute('alt', 'kept.png')
  })

  it('locks attaching while a turn runs: images go with the next message', () => {
    render(<Harness locked />)
    const attach = screen.getByRole('button', { name: 'Attach' })
    expect(attach).toHaveAttribute('aria-disabled', 'true')
    expect(attach).toHaveAttribute('title', 'Images go with the next message')
    // A tap on it says why, in place: a tooltip never shows on a phone.
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(attach)
    expect(screen.getByRole('status')).toHaveTextContent('images go with the next message')
    expect(document.querySelector('input[type=file]')).toBeInTheDocument()
  })

  it('lets the note go once the turn is over', () => {
    const { rerender } = render(<Harness locked />)
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))
    rerender(<Harness />)
    expect(screen.queryByText('images go with the next message')).toBeNull()
    expect(screen.getByRole('button', { name: 'Attach' })).not.toHaveAttribute('aria-disabled')
  })

  it('shows the picture of an image still uploading and lets it go after', async () => {
    const create = vi.fn(() => 'blob:thumb')
    const revoke = vi.fn()
    const spies = [vi.spyOn(URL, 'createObjectURL').mockImplementation(create), vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revoke)]
    let finish: (v: api.UploadedImage) => void = () => {}
    vi.mocked(api.uploadImage).mockImplementationOnce(() => new Promise((r) => (finish = r)))
    render(<Harness />)
    await userEvent.upload(screen.getByLabelText('attach images'), png('big.png'))
    const chip = screen.getByLabelText('uploading big.png')
    expect(chip.querySelector('img')).toHaveAttribute('src', 'blob:thumb')
    expect(chip.querySelector('.busy-mark')).not.toBeNull()
    await act(async () => finish({ id: 'big.png', mimeType: 'image/png' }))
    expect(revoke).toHaveBeenCalledWith('blob:thumb')
    spies.forEach((s) => s.mockRestore())
  })

  it('retries a failed upload with the same file', async () => {
    vi.mocked(api.uploadImage).mockRejectedValueOnce(new Error('network down'))
    render(<Harness />)
    await userEvent.upload(screen.getByLabelText('attach images'), png('again.png'))
    expect(await screen.findByRole('alert')).toHaveTextContent('again.png: network down')
    await userEvent.click(screen.getByRole('button', { name: 'retry again.png' }))
    await waitFor(() => expect(latest.ids).toEqual(['img1.png']))
    expect((vi.mocked(api.uploadImage).mock.calls[1]![1] as File).name).toBe('again.png')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('takes no pasted or dropped images while attaching is locked', () => {
    render(<Harness locked />)
    const form = screen.getByRole('form', { name: 'composer' })
    fireEvent.dragEnter(form, { dataTransfer: { types: ['Files'] } })
    expect(latest.dragging).toBe(false)
    fireEvent.paste(form, { clipboardData: { files: [png('pasted.png')] } })
    const dropped = fireEvent.drop(form, { dataTransfer: { files: [png('dropped.png')] } })
    expect(dropped).toBe(false)
    expect(api.uploadImage).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('images go with the next message')
  })
})
