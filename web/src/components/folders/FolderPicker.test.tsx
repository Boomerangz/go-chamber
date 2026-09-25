import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../lib/api'
import FolderPicker from './FolderPicker'

vi.mock('../../lib/api', () => ({ listFolders: vi.fn() }))

const listings: Record<string, api.FolderListing> = {
  '/Users/me': {
    path: '/Users/me', parent: '/Users', home: '/Users/me',
    folders: [
      { name: 'dev', path: '/Users/me/dev' },
      { name: 'go-chamber', path: '/Users/me/go-chamber', repo: true },
    ],
  },
  '/Users/me/dev': { path: '/Users/me/dev', parent: '/Users/me', home: '/Users/me', folders: [] },
  '/Users': { path: '/Users', parent: '/', home: '/Users/me', folders: [{ name: 'me', path: '/Users/me' }] },
  '/tmp': { path: '/tmp', parent: '/', home: '/Users/me', folders: [] },
}

beforeEach(() => {
  vi.mocked(api.listFolders).mockReset()
  vi.mocked(api.listFolders).mockImplementation(async (path = '') => {
    const l = listings[path || '/Users/me']
    if (!l) throw new Error(`folder not found: ${path}`)
    return l
  })
})

function setup(props: Partial<Parameters<typeof FolderPicker>[0]> = {}) {
  const onPick = vi.fn()
  const onClose = vi.fn()
  render(<FolderPicker onPick={onPick} onClose={onClose} {...props} />)
  return { onPick, onClose }
}

describe('FolderPicker', () => {
  it('opens at home and picks the current folder', async () => {
    const { onPick } = setup()
    expect(await screen.findByRole('button', { name: /^go-chamber/ })).toHaveTextContent('git')
    await userEvent.click(screen.getByRole('button', { name: 'Use this folder' }))
    expect(onPick).toHaveBeenCalledWith('/Users/me')
  })

  it('navigates into folders, up and through crumbs', async () => {
    const { onPick } = setup()
    await userEvent.click(await screen.findByRole('button', { name: 'dev' }))
    expect(await screen.findByText('No subfolders')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'dev', current: 'page' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '..' }))
    await userEvent.click(await screen.findByRole('button', { name: '..' }))
    expect(await screen.findByRole('button', { name: 'me' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'me' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Use this folder' }))
    expect(onPick).toHaveBeenLastCalledWith('/Users/me')
  })

  it('picks a listed folder with its Select button', async () => {
    const { onPick } = setup()
    await userEvent.click(await screen.findByRole('button', { name: 'Select go-chamber' }))
    expect(onPick).toHaveBeenCalledWith('/Users/me/go-chamber')
  })

  it('filters and enters the only match on Enter', async () => {
    setup()
    await screen.findByRole('button', { name: 'dev' })
    await userEvent.type(screen.getByLabelText('filter folders'), 'cham')
    expect(screen.queryByRole('button', { name: 'dev' })).toBeNull()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(api.listFolders).toHaveBeenLastCalledWith('/Users/me/go-chamber', false))
  })

  it('jumps to a typed path and shows errors', async () => {
    setup()
    await screen.findByRole('button', { name: 'dev' })
    await userEvent.type(screen.getByLabelText('filter folders'), '/tmp{Enter}')
    expect(await screen.findByText('No subfolders')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('filter folders'), '/nope{Enter}')
    expect(await screen.findByText(/folder not found/)).toBeInTheDocument()
    await userEvent.clear(screen.getByLabelText('filter folders'))
    await userEvent.type(screen.getByLabelText('filter folders'), 'zzz')
    expect(screen.getByText('No matching folders')).toBeInTheDocument()
  })

  it('starts at the given folder, falling back to home', async () => {
    setup({ start: '/Users/me/dev' })
    expect(await screen.findByText('No subfolders')).toBeInTheDocument()
  })

  it('falls back to home when the start folder is gone', async () => {
    setup({ start: '/gone' })
    expect(await screen.findByRole('button', { name: 'dev' })).toBeInTheDocument()
  })

  it('reports a failing initial listing', async () => {
    vi.mocked(api.listFolders).mockRejectedValue(new Error('down'))
    setup()
    expect(await screen.findByText('down')).toBeInTheDocument()
  })

  it('offers recent folders and hidden ones', async () => {
    setup({ recent: ['/tmp'] })
    await screen.findByRole('button', { name: 'dev' })
    await userEvent.click(screen.getByLabelText('Hidden'))
    expect(api.listFolders).toHaveBeenLastCalledWith('/Users/me', true)
    await userEvent.click(screen.getByRole('button', { name: 'tmp' }))
    expect(api.listFolders).toHaveBeenLastCalledWith('/tmp', true)
  })

  it('closes on Escape, Cancel, the close button and the backdrop', async () => {
    const { onClose } = setup()
    await screen.findByRole('button', { name: 'dev' })
    await userEvent.keyboard('{Escape}')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await userEvent.click(screen.getByRole('button', { name: 'Close folder picker' }))
    await userEvent.click(document.querySelector('.picker-backdrop')!)
    await userEvent.click(screen.getByRole('dialog'))
    expect(onClose).toHaveBeenCalledTimes(4)
  })
})

describe('FolderField', () => {
  it('fills the input from the picker', async () => {
    const { default: FolderField } = await import('./FolderField')
    const onChange = vi.fn()
    render(<FolderField label="dir" placeholder="p" value="" onChange={onChange} />)
    await userEvent.type(screen.getByLabelText('dir'), 'x')
    expect(onChange).toHaveBeenCalledWith('x')
    await userEvent.click(screen.getByRole('button', { name: 'Browse' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Select dev' }))
    expect(onChange).toHaveBeenLastCalledWith('/Users/me/dev')
    expect(screen.queryByRole('dialog')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Browse' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('FolderPicker inside a form', () => {
  it('never submits the surrounding form', async () => {
    const { default: FolderField } = await import('./FolderField')
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <FolderField label="dir" placeholder="p" value="" onChange={() => {}} />
      </form>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Browse' }))
    await userEvent.click(await screen.findByRole('button', { name: /^dev/ }))
    await userEvent.type(screen.getByLabelText('filter folders'), '/tmp{Enter}')
    await screen.findByRole('button', { name: 'tmp', current: 'page' })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog').closest('form')).toBeNull()
  })
})
