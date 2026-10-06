import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { resetStore, useSessionStore } from '../../stores/session'
import type { Session } from '../../lib/api'
import SessionMenu from './SessionMenu'

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

  it('closes when a scroll moves the row away, not on a scroll that leaves it', async () => {
    render(<Row />)
    await userEvent.click(trigger())
    fireEvent.scroll(window)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    trigger().getBoundingClientRect = () => ({ top: 40 }) as DOMRect
    fireEvent.scroll(window)
    expect(screen.queryByRole('menu')).toBeNull()
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
    const field = screen.getByRole('textbox', { name: 'session name' })
    expect(field).toHaveValue('Release notes')
    expect(field).toHaveFocus()
    await userEvent.clear(field)
    await userEvent.type(field, 'Changelog{Enter}')
    expect(actions.renameSession).toHaveBeenCalledWith('s1', 'Changelog')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    await userEvent.click(trigger())
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'session name' }), 'x{Escape}')
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

  it('does not offer to delete a running session', async () => {
    render(<Row session={{ ...base, status: 'running' }} />)
    await userEvent.click(trigger())
    const item = screen.getByRole('menuitem', { name: /Delete/ })
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toHaveTextContent('stop the turn first')
    await userEvent.click(item)
    expect(screen.queryByRole('group', { name: /Delete/ })).toBeNull()
  })
})
