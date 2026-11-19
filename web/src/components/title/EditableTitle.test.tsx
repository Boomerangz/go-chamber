import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import EditableTitle from './EditableTitle'

const setup = (value = 'Old name') => {
  const onRename = vi.fn(async () => {})
  render(<EditableTitle value={value} label="session" onRename={onRename} />)
  return onRename
}

describe('EditableTitle', () => {
  it('does not save or cancel a name while the input method is composing', async () => {
    const onRename = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Rename session' }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'New name' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input, { key: 'Escape', keyCode: 229 })
    expect(input).toHaveFocus()
    expect(onRename).not.toHaveBeenCalled()
  })
  it('shows saving and prevents overlapping renames, including an empty title', async () => {
    let settle!: (ok: boolean) => void
    const onRename = vi.fn(() => new Promise<boolean>((r) => { settle = r }))
    render(<EditableTitle value="Old name" label="session" onRename={onRename} />)
    await userEvent.click(screen.getByRole('button', { name: 'Rename session' }))
    await userEvent.clear(screen.getByRole('textbox'))
    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('status')).toHaveTextContent('Saving name')
    const button = screen.getByRole('button', { name: 'Rename session' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveFocus()
    await userEvent.click(button)
    await userEvent.dblClick(screen.getByText('Old name'))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(onRename).toHaveBeenCalledTimes(1)
    settle(false)
    await waitFor(() => expect(button).not.toHaveAttribute('aria-disabled'))
    await userEvent.click(button)
    expect(screen.getByRole('textbox')).toHaveFocus()
  })

  it('renames with the button and Enter', async () => {
    const onRename = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Rename session' }))
    const input = screen.getByRole('textbox', { name: 'Session name' })
    expect(input).toHaveValue('Old name')
    await userEvent.clear(input)
    await userEvent.type(input, 'New name{Enter}')
    expect(onRename).toHaveBeenCalledWith('New name')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('opens on double click and cancels with Escape', async () => {
    const onRename = setup()
    await userEvent.dblClick(screen.getByText('Old name'))
    await userEvent.type(screen.getByRole('textbox', { name: 'Session name' }), 'x{Escape}')
    expect(onRename).not.toHaveBeenCalled()
    expect(screen.getByText('Old name')).toBeInTheDocument()
  })

  it('does not call back when the name did not change', async () => {
    const onRename = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Rename session' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Session name' }), '{Enter}')
    expect(onRename).not.toHaveBeenCalled()
  })

  it('can be a heading named only by the title', () => {
    render(<EditableTitle heading value="Notes" label="session" onRename={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'Notes' })).toBeInTheDocument()
  })

  it('saves when focus leaves the field', async () => {
    const onRename = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Rename session' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Session name' }), '!')
    await userEvent.click(document.body)
    expect(onRename).toHaveBeenCalledWith('Old name!')
  })

  it('previews, replaces and removes a leading emoji without saving early', async () => {
    const onRename = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Rename session' }))
    await userEvent.click(screen.getByRole('button', { name: 'Choose title emoji' }))
    expect(screen.getByRole('dialog', { name: 'Title emoji' })).toBeVisible()
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search emoji' }), 'ракета')
    await userEvent.click(screen.getByRole('button', { name: '🚀 Rocket' }))
    expect(screen.getByRole('textbox', { name: 'Session name' })).toHaveValue('🚀 Old name')
    expect(screen.getByRole('textbox', { name: 'Session name' })).toHaveFocus()
    expect(onRename).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Change title emoji' }))
    await userEvent.click(screen.getByRole('button', { name: '🐛 Bug' }))
    expect(screen.getByRole('textbox')).toHaveValue('🐛 Old name')
    await userEvent.click(screen.getByRole('button', { name: 'Change title emoji' }))
    await userEvent.click(screen.getByRole('button', { name: 'Remove emoji' }))
    expect(screen.getByRole('textbox')).toHaveValue('Old name')
    await userEvent.type(screen.getByRole('textbox'), '!')
    await userEvent.click(screen.getByRole('button', { name: 'Save name' }))
    expect(onRename).toHaveBeenCalledWith('Old name!')
  })

  it('uses Tab to reach the picker, Escape closes it first and then cancels editing', async () => {
    const onRename = setup('👩🏽‍💻 Notes')
    await userEvent.click(screen.getByRole('button', { name: 'Rename session' }))
    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'Change title emoji' })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    await userEvent.type(screen.getByRole('searchbox'), 'no such emoji')
    expect(screen.getByRole('status')).toHaveTextContent('No emoji found')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('textbox')).toHaveValue('👩🏽‍💻 Notes')
    expect(screen.getByRole('button', { name: 'Change title emoji' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(onRename).not.toHaveBeenCalled()
  })

  it('selects a search result with the keyboard and cancels the whole draft', async () => {
    const onRename = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Rename session' }))
    await userEvent.click(screen.getByRole('button', { name: 'Choose title emoji' }))
    await userEvent.type(screen.getByRole('searchbox'), 'rocket{ArrowDown}{Enter}')
    expect(screen.getByRole('textbox')).toHaveValue('🚀 Old name')
    await userEvent.keyboard('{Escape}')
    expect(screen.getByText('Old name')).toBeInTheDocument()
    expect(onRename).not.toHaveBeenCalled()
  })

  it('keeps a full-length title intact instead of truncating it to add an emoji', async () => {
    setup('x'.repeat(200))
    await userEvent.click(screen.getByRole('button', { name: 'Rename session' }))
    await userEvent.click(screen.getByRole('button', { name: 'Choose title emoji' }))
    expect(screen.getByRole('button', { name: '🚀 Rocket' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove emoji' })).toBeDisabled()
    await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('textbox')).toHaveValue('x'.repeat(200))
  })

  it('navigates the palette with arrows, Home and End', async () => {
    setup()
    await userEvent.click(screen.getByRole('button', { name: 'Rename session' }))
    await userEvent.click(screen.getByRole('button', { name: 'Choose title emoji' }))
    await userEvent.keyboard('{ArrowDown}{ArrowRight}')
    expect(screen.getByRole('button', { name: '🐛 Bug' })).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}{ArrowUp}{ArrowLeft}')
    expect(screen.getByRole('button', { name: '🚀 Rocket' })).toHaveFocus()
    await userEvent.keyboard('{End}')
    expect(screen.getByRole('button', { name: '🎮 Game' })).toHaveFocus()
    await userEvent.keyboard('{Home}')
    expect(screen.getByRole('button', { name: '🚀 Rocket' })).toHaveFocus()
    await userEvent.click(screen.getByRole('button', { name: 'Close emoji picker' }))
    expect(screen.getByRole('button', { name: 'Choose title emoji' })).toHaveFocus()
  })

  it('does not commit when clicking a heading or empty space inside the palette', async () => {
    const onRename = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Rename session' }))
    await userEvent.click(screen.getByRole('button', { name: 'Choose title emoji' }))
    await userEvent.click(screen.getByText('One emoji at the start of your name.'))
    expect(screen.getByRole('dialog', { name: 'Title emoji' })).toBeInTheDocument()
    expect(onRename).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: '🚀 Rocket' }))
    expect(screen.getByRole('textbox')).toHaveValue('🚀 Old name')
  })

  it('shows the new name while the rename is on its way and keeps it on success', async () => {
    let settle!: (ok: boolean) => void
    const onRename = vi.fn(() => new Promise<boolean>((r) => (settle = r)))
    const { rerender } = render(<EditableTitle value="Old name" label="session" onRename={onRename} />)
    await userEvent.click(screen.getByRole('button', { name: 'Rename session' }))
    await userEvent.clear(screen.getByRole('textbox'))
    await userEvent.type(screen.getByRole('textbox'), 'New name{Enter}')
    expect(screen.getByText('New name')).toBeInTheDocument()
    rerender(<EditableTitle value="New name" label="session" onRename={onRename} />)
    settle(true)
    await waitFor(() => expect(screen.getByText('New name')).toBeInTheDocument())
  })

  it('goes back to the old name when the rename fails', async () => {
    let settle!: (ok: boolean) => void
    const onRename = vi.fn(() => new Promise<boolean>((r) => (settle = r)))
    render(<EditableTitle value="Old name" label="session" onRename={onRename} />)
    await userEvent.click(screen.getByRole('button', { name: 'Rename session' }))
    await userEvent.clear(screen.getByRole('textbox'))
    await userEvent.type(screen.getByRole('textbox'), 'New name{Enter}')
    expect(screen.getByText('New name')).toBeInTheDocument()
    settle(false)
    expect(await screen.findByText('Old name')).toBeInTheDocument()
    expect(screen.queryByText('New name')).toBeNull()
  })

  it('returns focus to the rename button after saving or cancelling', async () => {
    setup()
    const button = screen.getByRole('button', { name: 'Rename session' })
    await userEvent.click(button)
    await userEvent.type(screen.getByRole('textbox'), '{Escape}')
    expect(screen.getByRole('button', { name: 'Rename session' })).toHaveFocus()
    await userEvent.click(screen.getByRole('button', { name: 'Rename session' }))
    await userEvent.type(screen.getByRole('textbox'), '!{Enter}')
    expect(screen.getByRole('button', { name: 'Rename session' })).toHaveFocus()
  })

  it('draws a pencil icon', () => {
    setup()
    const button = screen.getByRole('button', { name: 'Rename session' })
    expect(button.querySelector('svg')).not.toBeNull()
    expect(button.textContent).toBe('')
  })
})
