import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { resetStore, useSessionStore } from '../../stores/session'
import type { Session } from '../../lib/api'
import { useNotices } from '../../stores/notices'
import * as api from '../../lib/api'
import SessionMenu from './SessionMenu'

vi.mock('../../lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/api')>()), interrupt: vi.fn() }))

const base: Session = { id: 's1', title: 'Release notes', agent: 'claude', cwd: '/src/app', status: 'idle' }

type Act = Mock<(id: string) => Promise<boolean>>
let actions: {
  renameSession: Mock<(id: string, title: string) => Promise<boolean>>
  archiveSession: Act
  unarchiveSession: Act
  deleteSession: Act
}

beforeEach(() => {
  resetStore()
  useNotices.setState({ notices: [] })
  actions = {
    renameSession: vi.fn(async (_id: string, _title: string) => true),
    archiveSession: vi.fn(async (_id: string) => true),
    unarchiveSession: vi.fn(async (_id: string) => true),
    deleteSession: vi.fn(async (_id: string) => true),
  }
  useSessionStore.setState(actions)
})

// Row renders the menu the way the sidebar does: inside a list item, after
// the row's button.
function Row({ session = base, child }: { session?: Session; child?: Session }) {
  return (
    <ul>
      <li>
        <button>{session.title}</button>
        <SessionMenu session={session} />
        {child && (
          <ul>
            <li>
              <button>{child.title}</button>
              <SessionMenu session={child} />
            </li>
          </ul>
        )}
      </li>
    </ul>
  )
}

const trigger = (title = 'Release notes') => screen.getByRole('button', { name: `Actions for ${title}` })

// List renders sibling rows; an archived or deleted row leaves the list.
function List({ gone = [] as string[] }) {
  const rows: Session[] = [base, { ...base, id: 's2', title: 'Second' }, { ...base, id: 's3', title: 'Third' }]
  return (
    <ul>
      {rows
        .filter((s) => !gone.includes(s.id))
        .map((s) => (
          <li key={s.id}>
            <button className="session">{s.title}</button>
            <SessionMenu session={s} />
          </li>
        ))}
    </ul>
  )
}

describe('SessionMenu focus after the row leaves', () => {
  it('moves focus to the next row once archived', async () => {
    const view = render(<List />)
    actions.archiveSession.mockImplementation(async () => {
      view.rerender(<List gone={['s2']} />)
      return true
    })
    await userEvent.click(trigger('Second'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Third' })).toHaveFocus())
  })

  it("follows the open session's row into Archived instead of a neighbour", async () => {
    // The fold opens and scrolls to the open session's row: focus on a
    // neighbour would scroll the list away from it again.
    useSessionStore.setState({ activeId: 's2' })
    const shelf = (
      <details open className="archived">
        <summary>Archived</summary>
        <button className="session" data-session="s2">
          Second (archived)
        </button>
      </details>
    )
    const view = render(<List />)
    actions.archiveSession.mockImplementation(async () => {
      view.rerender(
        <>
          <List gone={['s2']} />
          {shelf}
        </>,
      )
      return true
    })
    await userEvent.click(trigger('Second'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Second (archived)' })).toHaveFocus())
  })

  it('moves focus to the previous row when the last one is deleted', async () => {
    const view = render(<List />)
    actions.deleteSession.mockImplementation(async () => {
      view.rerender(<List gone={['s3']} />)
      return true
    })
    await userEvent.click(trigger('Third'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Second' })).toHaveFocus())
  })
})

describe('SessionMenu focus on a touch screen', () => {
  const touch = () =>
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('pointer: coarse'), media: q, addEventListener: () => {}, removeEventListener: () => {},
    }))
  afterEach(() => vi.unstubAllGlobals())

  it('does not put the focus in the search field when no row is left: the keyboard would come up', async () => {
    touch()
    const view = render(
      <>
        <input aria-label="Search sessions" />
        <List />
      </>,
    )
    actions.archiveSession.mockImplementation(async () => {
      view.rerender(
        <>
          <input aria-label="Search sessions" />
          <List gone={['s1', 's2', 's3']} />
        </>,
      )
      return true
    })
    await userEvent.click(trigger('Second'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
    await waitFor(() => expect(actions.archiveSession).toHaveBeenCalled())
    await act(async () => {})
    expect(screen.getByLabelText('Search sessions')).not.toHaveFocus()
  })

  it("Undo hands the focus to the restored row, not the open session's composer", async () => {
    touch()
    useSessionStore.setState({ activeId: 's1' })
    const { rerender } = render(<Row />)
    await userEvent.click(trigger())
    await userEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
    await waitFor(() => expect(useNotices.getState().notices).toHaveLength(1))
    rerender(
      <>
        <Row />
        <button type="button" className="session" data-session="s1">
          restored
        </button>
        <textarea aria-label="Message" />
      </>,
    )
    useNotices.getState().notices[0]!.action!.run()
    await waitFor(() => expect(screen.getByRole('button', { name: 'restored' })).toHaveFocus())
  })
})

describe('SessionMenu', () => {
  it('opens from its button with the first item focused, and Escape closes it', async () => {
    render(<Row />)
    expect(trigger()).toHaveAttribute('aria-haspopup', 'menu')
    await userEvent.click(trigger())
    expect(trigger()).toHaveAttribute('aria-expanded', 'true')
    const items = screen.getAllByRole('menuitem')
    expect(items.map((i) => i.textContent)).toEqual(['Rename', 'Archive', 'Delete…'])
    expect(items[0]).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger()).toHaveFocus()
  })

  it('moves between items with the arrow keys, Home and End', async () => {
    render(<Row />)
    trigger().focus()
    await userEvent.keyboard('{Enter}')
    const items = screen.getAllByRole('menuitem')
    await userEvent.keyboard('{ArrowDown}')
    expect(items[1]).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(items[0]).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}')
    expect(items[2]).toHaveFocus()
    await userEvent.keyboard('{Home}')
    expect(items[0]).toHaveFocus()
    await userEvent.keyboard('{End}')
    expect(items[2]).toHaveFocus()
    await userEvent.keyboard('{Tab}')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens on right click of the row, and only for that row', async () => {
    const child: Session = { ...base, id: 's2', title: 'Subagent', parentId: 's1' }
    render(<Row child={child} />)
    const notPrevented = fireEvent.contextMenu(screen.getByRole('button', { name: 'Subagent' }))
    expect(notPrevented).toBe(false)
    expect(screen.getByRole('menu', { name: 'Subagent' })).toBeInTheDocument()
    expect(screen.getAllByRole('menu')).toHaveLength(1)
  })

  it('closes on a click elsewhere', async () => {
    render(<Row />)
    await userEvent.click(trigger())
    await userEvent.click(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps a phone gutter between the sheet and the screen edge', async () => {
    const width = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true })
    try {
      render(<Row />)
      trigger().getBoundingClientRect = () => ({ top: 100, bottom: 128, right: 390 }) as DOMRect
      await userEvent.click(trigger())
      // jsdom lays the sheet out 0 wide: its right edge is its left
      expect(parseFloat(screen.getByRole('menu').style.left)).toBe(390 - 14)
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
    }
  })

  it('follows a row that moves on screen, and closes once the row scrolls out of view', async () => {
    render(<Row />)
    trigger().getBoundingClientRect = () => ({ top: 100, bottom: 128, right: 300 }) as DOMRect
    await userEvent.click(trigger())
    const menu = screen.getByRole('menu')
    const top = () => parseFloat(menu.style.top)
    const before = top()
    fireEvent.scroll(window)
    expect(screen.getByRole('menu')).toBe(menu)
    // A list update above shifts the row (scroll anchoring fires a scroll): the sheet moves with it.
    trigger().getBoundingClientRect = () => ({ top: 160, bottom: 188, right: 300 }) as DOMRect
    fireEvent.scroll(window)
    expect(screen.getByRole('menu')).toBe(menu)
    expect(top()).toBe(before + 60)
    trigger().getBoundingClientRect = () => ({ top: -40, bottom: -12, right: 300 }) as DOMRect
    fireEvent.scroll(window)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('follows a row that a list update moves without any scroll', async () => {
    render(<Row />)
    trigger().getBoundingClientRect = () => ({ top: 100, bottom: 128, right: 300 }) as DOMRect
    await userEvent.click(trigger())
    const menu = screen.getByRole('menu')
    const before = parseFloat(menu.style.top)
    // Another page's session joins the list above: the row moves, nothing scrolls.
    trigger().getBoundingClientRect = () => ({ top: 190, bottom: 218, right: 300 }) as DOMRect
    await waitFor(() => expect(parseFloat(menu.style.top)).toBe(before + 90))
    // Pushed out of view the same way, it closes.
    trigger().getBoundingClientRect = () => ({ top: window.innerHeight + 10, bottom: window.innerHeight + 38, right: 300 }) as DOMRect
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('keeps to the moved row when the menu turns into the delete question', async () => {
    render(<Row />)
    trigger().getBoundingClientRect = () => ({ top: 100, bottom: 128, right: 300 }) as DOMRect
    await userEvent.click(trigger())
    const before = parseFloat(screen.getByRole('menu').style.top)
    trigger().getBoundingClientRect = () => ({ top: 160, bottom: 188, right: 300 }) as DOMRect
    fireEvent.scroll(window)
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    expect(parseFloat(screen.getByRole('dialog').style.top)).toBe(before + 60)
  })

  it('keeps the rename field open when a phone keyboard shrinks the viewport, and closes on a width change', async () => {
    const height = window.innerHeight
    const width = window.innerWidth
    try {
      render(<Row />)
      trigger().getBoundingClientRect = () => ({ top: 600, bottom: 628, right: 300 }) as DOMRect
      await userEvent.click(trigger())
      await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
      const field = screen.getByRole('textbox')
      expect(document.activeElement).toBe(field)
      // The keyboard opens: the viewport loses height, and the row falls below it.
      Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true })
      fireEvent(window, new Event('resize'))
      fireEvent.scroll(window)
      expect(screen.getByRole('textbox')).toBe(field)
      // Turning the phone (a width change) still closes it.
      Object.defineProperty(window, 'innerWidth', { value: width + 200, configurable: true })
      fireEvent(window, new Event('resize'))
      expect(screen.queryByRole('textbox')).toBeNull()
    } finally {
      Object.defineProperty(window, 'innerHeight', { value: height, configurable: true })
      Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
    }
  })

  it('archives, or unarchives an archived session', async () => {
    const { unmount } = render(<Row />)
    await userEvent.click(trigger())
    await userEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
    expect(actions.archiveSession).toHaveBeenCalledWith('s1')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    unmount()

    render(<Row session={{ ...base, archivedAt: '2026-10-06T09:00:00Z' }} />)
    await userEvent.click(trigger())
    await userEvent.click(screen.getByRole('menuitem', { name: 'Unarchive' }))
    expect(actions.unarchiveSession).toHaveBeenCalledWith('s1')
  })

  it('renames in place: Enter saves, Escape keeps the name', async () => {
    render(<Row />)
    await userEvent.click(trigger())
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const field = screen.getByRole('textbox', { name: 'Session name' })
    expect(field).toHaveValue('Release notes')
    expect(field).toHaveFocus()
    await userEvent.clear(field)
    await userEvent.type(field, 'Changelog{Enter}')
    expect(actions.renameSession).toHaveBeenCalledWith('s1', 'Changelog')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    await userEvent.click(trigger())
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Session name' }), 'x{Escape}')
    expect(actions.renameSession).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger()).toHaveFocus()
  })

  it('asks before deleting and says the transcript stays', async () => {
    render(<Row />)
    await userEvent.click(trigger())
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    const confirm = screen.getByRole('group', { name: 'Delete Release notes?' })
    expect(confirm).toHaveTextContent(/transcript on disk stays/)
    // the popover may cover the row: the question names the session itself
    expect(confirm).toHaveTextContent('Delete “Release notes” from go-chamber?')
    expect(screen.getByRole('button', { name: 'Keep' })).toHaveFocus()
    await userEvent.click(screen.getByRole('button', { name: 'Keep' }))
    expect(actions.deleteSession).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()

    await userEvent.click(trigger())
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(actions.deleteSession).toHaveBeenCalledWith('s1')
  })

  it('reaches the delete question from the keyboard and keeps it', async () => {
    render(<Row />)
    await userEvent.click(trigger())
    await userEvent.keyboard('{End}{Enter}')
    expect(screen.getByRole('group', { name: 'Delete Release notes?' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keep' })).toHaveFocus()
  })

  it('shows the delete as busy while it is on its way', async () => {
    let release: (ok: boolean) => void = () => {}
    actions.deleteSession.mockReturnValueOnce(new Promise((r) => (release = r)))
    render(<Row />)
    await userEvent.click(trigger())
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const busy = screen.getByRole('button', { name: 'Deleting…' })
    expect(busy).toHaveAttribute('aria-busy', 'true')
    release(false)
    // A refused delete leaves the question for another try.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument())
  })

  it('closes the menu when an archive fails: the error notice explains', async () => {
    actions.archiveSession.mockResolvedValueOnce(false)
    render(<Row />)
    await userEvent.click(trigger())
    await userEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(trigger()).toHaveFocus()
  })

  it('says an archive happened and undoes it from the notice', async () => {
    render(<Row />)
    await userEvent.click(trigger())
    await userEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
    await waitFor(() => expect(useNotices.getState().notices).toHaveLength(1))
    const notice = useNotices.getState().notices[0]!
    expect(notice).toMatchObject({ kind: 'info', text: 'Archived Release notes' })
    notice.action!.run()
    expect(actions.unarchiveSession).toHaveBeenCalledWith('s1')
  })

  it('Undo hands the focus to the restored row, or the composer of the open session', async () => {
    const { rerender } = render(<Row />)
    await userEvent.click(trigger())
    await userEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
    await waitFor(() => expect(useNotices.getState().notices).toHaveLength(1))
    rerender(
      <>
        <Row />
        <button type="button" className="session" data-session="s1">
          restored
        </button>
        <textarea aria-label="Message" />
      </>,
    )
    useNotices.getState().notices[0]!.action!.run()
    await waitFor(() => expect(screen.getByRole('button', { name: 'restored' })).toHaveFocus())

    useSessionStore.setState({ activeId: 's1' })
    useNotices.setState({ notices: [] })
    screen.getByRole('button', { name: 'restored' }).blur()
    await userEvent.click(trigger())
    await userEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
    await waitFor(() => expect(useNotices.getState().notices).toHaveLength(1))
    useNotices.getState().notices[0]!.action!.run()
    await waitFor(() => expect(screen.getByLabelText('Message')).toHaveFocus())
  })

  it('stops a running turn from the menu, archived or not', async () => {
    ;(api.interrupt as Mock).mockResolvedValue(undefined)
    render(<Row session={{ ...base, status: 'running', archivedAt: '2026-10-06T09:00:00Z' }} />)
    await userEvent.click(trigger())
    await userEvent.click(screen.getByRole('menuitem', { name: 'Stop turn' }))
    expect(api.interrupt).toHaveBeenCalledWith('s1')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('offers no Stop turn while nothing runs', async () => {
    render(<Row />)
    await userEvent.click(trigger())
    expect(screen.queryByRole('menuitem', { name: 'Stop turn' })).toBeNull()
  })

  it('does not offer to delete a running session', async () => {
    render(<Row session={{ ...base, status: 'running' }} />)
    await userEvent.click(trigger())
    const item = screen.getByRole('menuitem', { name: /Delete/ })
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toHaveTextContent('stop first')
    await userEvent.click(item)
    expect(screen.queryByRole('group', { name: /Delete/ })).toBeNull()
  })
})
