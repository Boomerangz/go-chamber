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
    await userEvent.tab()
    expect(onRename).toHaveBeenCalledWith('Old name!')
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
