import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import EditableTitle from './EditableTitle'

const setup = (value = 'Old name') => {
  const onRename = vi.fn(async () => {})
  render(<EditableTitle value={value} label="session" onRename={onRename} />)
  return onRename
}

describe('EditableTitle', () => {
  it('renames with the button and Enter', async () => {
    const onRename = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Rename session' }))
    const input = screen.getByRole('textbox', { name: 'session name' })
    expect(input).toHaveValue('Old name')
    await userEvent.clear(input)
    await userEvent.type(input, 'New name{Enter}')
    expect(onRename).toHaveBeenCalledWith('New name')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('opens on double click and cancels with Escape', async () => {
    const onRename = setup()
    await userEvent.dblClick(screen.getByText('Old name'))
    await userEvent.type(screen.getByRole('textbox', { name: 'session name' }), 'x{Escape}')
    expect(onRename).not.toHaveBeenCalled()
    expect(screen.getByText('Old name')).toBeInTheDocument()
  })

  it('does not call back when the name did not change', async () => {
    const onRename = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Rename session' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'session name' }), '{Enter}')
    expect(onRename).not.toHaveBeenCalled()
  })

  it('can be a heading named only by the title', () => {
    render(<EditableTitle heading value="Notes" label="session" onRename={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'Notes' })).toBeInTheDocument()
  })

  it('saves when focus leaves the field', async () => {
    const onRename = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Rename session' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'session name' }), '!')
    await userEvent.tab()
    expect(onRename).toHaveBeenCalledWith('Old name!')
  })
})
