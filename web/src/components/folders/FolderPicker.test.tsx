import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
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
  localStorage.clear()
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
    await userEvent.type(screen.getByLabelText('Filter folders'), 'cham')
    expect(screen.queryByRole('button', { name: 'dev' })).toBeNull()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(api.listFolders).toHaveBeenLastCalledWith('/Users/me/go-chamber', false))
  })

  it('jumps to a typed path and shows errors', async () => {
    setup()
    await screen.findByRole('button', { name: 'dev' })
    await userEvent.type(screen.getByLabelText('Filter folders'), '/tmp{Enter}')
    expect(await screen.findByText('No subfolders')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Filter folders'), '/nope{Enter}')
    expect(await screen.findByText(/folder not found/)).toBeInTheDocument()
    await userEvent.clear(screen.getByLabelText('Filter folders'))
    await userEvent.type(screen.getByLabelText('Filter folders'), 'zzz')
    expect(screen.getByText('No matching folders')).toBeInTheDocument()
  })

  it('starts at the given folder, falling back to home', async () => {
    setup({ start: '/Users/me/dev' })
    expect(await screen.findByText('No subfolders')).toBeInTheDocument()
  })

  it('falls back to home when the start folder is gone, and says so', async () => {
    setup({ start: '/gone' })
    expect(await screen.findByRole('button', { name: 'dev' })).toBeInTheDocument()
    expect(screen.getByText('/gone not found, showing home')).toBeInTheDocument()
  })

  it('reports a failing initial listing', async () => {
    vi.mocked(api.listFolders).mockRejectedValue(new Error('down'))
    setup()
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't list your home folder: down")
    // home is what failed: no second way to it
    expect(screen.queryByRole('button', { name: 'Go home' })).toBeNull()
  })

  it('offers recent folders and hidden ones', async () => {
    setup({ recent: ['/tmp'] })
    await screen.findByRole('button', { name: 'dev' })
    await userEvent.click(screen.getByLabelText('Hidden'))
    expect(api.listFolders).toHaveBeenLastCalledWith('/Users/me', true)
    const browse = screen.getByRole('button', { name: 'Browse inside /tmp' })
    expect(browse).toHaveAttribute('title', 'Browse inside /tmp')
    await userEvent.click(browse)
    expect(api.listFolders).toHaveBeenLastCalledWith('/tmp', true)
  })

  it('reads a path outside home as / tmp, with one slash after the root', async () => {
    setup({ recent: ['/tmp'] })
    await screen.findByRole('button', { name: 'dev' })
    await userEvent.click(screen.getByRole('button', { name: 'Browse inside /tmp' }))
    const nav = await screen.findByRole('navigation', { name: 'Folder path' })
    await waitFor(() => expect(nav).toHaveTextContent(/^\/tmp$/))
  })

  it('picks a recent folder with one click', async () => {
    const { onPick } = setup({ recent: ['/tmp'] })
    await screen.findByRole('button', { name: 'dev' })
    await userEvent.click(screen.getByRole('button', { name: 'tmp' }))
    expect(onPick).toHaveBeenCalledWith('/tmp')
  })

  it('holds "Use this folder" while the next listing loads, marking the clicked row', async () => {
    const { onPick } = setup()
    await screen.findByRole('button', { name: 'dev' })
    let slow!: (l: api.FolderListing) => void
    vi.mocked(api.listFolders).mockReturnValueOnce(new Promise((r) => (slow = r)))
    await userEvent.click(screen.getByRole('button', { name: 'dev' }))
    expect(screen.getByRole('button', { name: 'dev' })).toHaveAttribute('aria-busy', 'true')
    const use = screen.getByRole('button', { name: 'Use this folder' })
    expect(use).toBeDisabled()
    expect(use).toHaveAttribute('aria-busy', 'true')
    await act(async () => slow(listings['/Users/me/dev']))
    await userEvent.click(screen.getByRole('button', { name: 'Use this folder' }))
    expect(onPick).toHaveBeenCalledWith('/Users/me/dev')
  })

  it('retries a failed move with the listing still shown', async () => {
    setup()
    await screen.findByRole('button', { name: 'dev' })
    vi.mocked(api.listFolders).mockRejectedValueOnce(new Error('timed out'))
    await userEvent.click(screen.getByRole('button', { name: 'dev' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/timed out/)
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No subfolders')).toBeInTheDocument()
    expect(screen.queryByText(/timed out/)).toBeNull()
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

describe('FolderPicker loading and keys', () => {
  it('says it is loading before the first listing arrives', async () => {
    let resolve!: (l: api.FolderListing) => void
    vi.mocked(api.listFolders).mockReturnValueOnce(new Promise((r) => (resolve = r)))
    setup()
    expect(screen.getByText('loading…')).toBeInTheDocument()
    await act(async () => resolve(listings['/Users/me']))
    expect(screen.queryByText('loading…')).toBeNull()
    expect(screen.getByRole('button', { name: 'dev' })).toBeInTheDocument()
  })

  it('shows the folder clicked last even when an earlier listing answers later', async () => {
    setup()
    await screen.findByRole('button', { name: 'dev' })
    let slow!: (l: api.FolderListing) => void
    vi.mocked(api.listFolders).mockReturnValueOnce(new Promise((r) => (slow = r)))
    await userEvent.click(screen.getByRole('button', { name: 'dev' }))
    await userEvent.click(screen.getByRole('button', { name: '..' }))
    expect(await screen.findByRole('button', { name: 'me' })).toBeInTheDocument()
    await act(async () => slow(listings['/Users/me/dev']))
    expect(screen.getByRole('button', { name: 'me' })).toBeInTheDocument()
    expect(screen.queryByText('No subfolders')).toBeNull()
  })

  it('offers to go home when the first listing fails', async () => {
    vi.mocked(api.listFolders).mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('down'))
    setup({ start: '/gone' })
    await userEvent.click(await screen.findByRole('button', { name: 'Go home' }))
    expect(await screen.findByRole('button', { name: 'dev' })).toBeInTheDocument()
    expect(api.listFolders).toHaveBeenLastCalledWith('', false)
  })

  it('says which folder it could not list, keeps its path, and offers Retry and Go home', async () => {
    vi.mocked(api.listFolders).mockRejectedValueOnce(new Error('boom')).mockRejectedValueOnce(new Error('boom'))
    setup({ start: '/srv/work/app' })
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't list this folder: boom")
    const path = screen.getByRole('navigation', { name: 'Folder path' })
    expect(path).toHaveTextContent('/srv/work/app')
    // Retry asks for the same folder again
    vi.mocked(api.listFolders).mockResolvedValueOnce(listings['/tmp'])
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(api.listFolders).toHaveBeenLastCalledWith('/srv/work/app', false)
    expect(await screen.findByText('No subfolders')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('names a failed move the same way, over the listing still shown', async () => {
    setup()
    await screen.findByRole('button', { name: 'dev' })
    vi.mocked(api.listFolders).mockRejectedValueOnce(new Error('permission denied'))
    await userEvent.click(screen.getByRole('button', { name: 'dev' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't list dev: permission denied")
  })

  it('moves through folders with the arrow keys from the filter', async () => {
    setup()
    await screen.findByRole('button', { name: 'dev' })
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('button', { name: '..' })).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('button', { name: 'dev' })).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}{ArrowUp}')
    expect(screen.getByLabelText('Filter folders')).toHaveFocus()
  })

  it('goes to the parent with Backspace in an empty filter', async () => {
    setup({ start: '/Users/me/dev' })
    await screen.findByText('No subfolders')
    await userEvent.type(screen.getByLabelText('Filter folders'), 'x{Backspace}')
    expect(api.listFolders).toHaveBeenCalledTimes(1)
    await userEvent.keyboard('{Backspace}')
    expect(await screen.findByRole('button', { name: 'dev' })).toBeInTheDocument()
    expect(api.listFolders).toHaveBeenLastCalledWith('/Users/me', false)
  })

  it('selects a folder on double click', async () => {
    const { onPick } = setup()
    await userEvent.dblClick(await screen.findByRole('button', { name: /^go-chamber/ }))
    expect(onPick).toHaveBeenCalledWith('/Users/me/go-chamber')
  })

  it('keeps Tab inside the picker', async () => {
    setup()
    await screen.findByRole('button', { name: 'dev' })
    const dialog = screen.getByRole('dialog')
    screen.getByRole('button', { name: 'Use this folder' }).focus()
    await userEvent.tab()
    expect(dialog).toContainElement(document.activeElement as HTMLElement)
    expect(screen.getByRole('button', { name: 'Close folder picker' })).toHaveFocus()
    await userEvent.tab({ shift: true })
    expect(screen.getByRole('button', { name: 'Use this folder' })).toHaveFocus()
  })

  it('remembers the Hidden choice', async () => {
    setup()
    await screen.findByRole('button', { name: 'dev' })
    await userEvent.click(screen.getByLabelText('Hidden'))
    cleanup()
    setup()
    await screen.findByRole('button', { name: 'dev' })
    expect(screen.getByLabelText('Hidden')).toBeChecked()
    expect(api.listFolders).toHaveBeenLastCalledWith('', true)
  })
})

describe('FolderField', () => {
  it('returns focus to Browse when the picker closes', async () => {
    const { default: FolderField } = await import('./FolderField')
    render(<FolderField label="dir" placeholder="p" value="" onChange={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Browse' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Browse' })).toHaveFocus()
  })

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

  it('shows the end of a long path, the project name, while not typing in it', async () => {
    const { default: FolderField } = await import('./FolderField')
    const { rerender } = render(<FolderField label="dir" placeholder="p" value="" onChange={() => {}} />)
    const input = screen.getByLabelText<HTMLInputElement>('dir')
    Object.defineProperty(input, 'scrollWidth', { configurable: true, value: 900 })
    rerender(<FolderField label="dir" placeholder="p" value="/a/very/long/path/project" onChange={() => {}} />)
    expect(input.scrollLeft).toBe(900)
    input.focus()
    input.scrollLeft = 0
    rerender(<FolderField label="dir" placeholder="p" value="/a/very/long/path/project2" onChange={() => {}} />)
    expect(input.scrollLeft).toBe(0)
    input.blur()
    expect(input.scrollLeft).toBe(900)
  })
})

describe('FolderPicker on a touch screen', () => {
  it('leaves the filter alone, so no keyboard covers the list', async () => {
    const media = window.matchMedia
    window.matchMedia = vi.fn((q: string) => ({ matches: q.includes('coarse') })) as never
    try {
      setup()
      await userEvent.click(await screen.findByRole('button', { name: 'dev' }))
      await screen.findByText('No subfolders')
      expect(screen.getByLabelText('Filter folders')).not.toHaveFocus()
      expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
    } finally {
      window.matchMedia = media
    }
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
    await userEvent.type(screen.getByLabelText('Filter folders'), '/tmp{Enter}')
    await screen.findByRole('button', { name: 'tmp', current: 'page' })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog').closest('form')).toBeNull()
  })
})
