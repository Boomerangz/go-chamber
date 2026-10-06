import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../lib/api'
import { resetStore } from '../../stores/session'
import PermissionModeSelect from './PermissionModeSelect'

vi.mock('../../lib/api', () => ({ setPermissionMode: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('WebSocket', undefined)
  resetStore()
  vi.mocked(api.setPermissionMode).mockImplementation(async (id, mode) => ({ id, agent: 'claude', cwd: '/p', status: 'idle', permissionMode: mode }))
})

describe('PermissionModeSelect', () => {
  it('offers the Claude modes and switches the session', async () => {
    render(<PermissionModeSelect session={{ id: 's', agent: 'claude', cwd: '/p', status: 'idle', permissionMode: 'plan' }} />)
    const select = screen.getByLabelText('Permission mode')
    expect(select).toHaveValue('plan')
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('value'))).toEqual(['', 'default', 'acceptEdits', 'plan', 'bypassPermissions'])
    await userEvent.selectOptions(select, 'acceptEdits')
    expect(api.setPermissionMode).toHaveBeenCalledWith('s', 'acceptEdits')
  })

  it('names its default plainly and says where it comes from, the word "Mode" only where settings stack', () => {
    render(<PermissionModeSelect session={{ id: 's', agent: 'claude', cwd: '/p', status: 'idle' }} />)
    const select = screen.getByLabelText('Permission mode')
    expect(select.querySelector('option[value=""]')).toHaveTextContent(/^Default mode$/)
    expect(select).toHaveAttribute('title', 'Permission mode · default: as the Claude config sets it')
    expect(screen.getByText('Mode')).toHaveClass('tool-label')
  })

  it('offers the Codex presets', () => {
    render(<PermissionModeSelect session={{ id: 's', agent: 'codex', cwd: '/p', status: 'idle' }} />)
    expect(screen.getByLabelText('Permission mode')).toHaveValue('')
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('value'))).toEqual(['', 'read-only', 'auto', 'full-access'])
  })

  it('shows the new mode at once while it saves and goes back if it fails', async () => {
    let finish: (ok: boolean) => void = () => {}
    vi.mocked(api.setPermissionMode).mockImplementation(
      (id, mode) =>
        new Promise((resolve, reject) => {
          finish = (ok) => (ok ? resolve({ id, agent: 'claude', cwd: '/p', status: 'idle', permissionMode: mode }) : reject(new Error('no')))
        }),
    )
    render(<PermissionModeSelect session={{ id: 's', agent: 'claude', cwd: '/p', status: 'idle', permissionMode: 'plan' }} />)
    const select = screen.getByLabelText('Permission mode')
    await userEvent.selectOptions(select, 'acceptEdits')
    expect(select).toHaveValue('acceptEdits')
    expect(select).toHaveAttribute('aria-busy', 'true')
    expect(document.querySelector('.reviewer .busy-mark')).not.toBeNull()
    finish(false)
    await vi.waitFor(() => expect(select).toHaveValue('plan'))
    expect(select).not.toHaveAttribute('aria-busy')
    expect(document.querySelector('.reviewer .busy-mark')).toBeNull()
  })

  it('asks before switching to a mode that never asks', async () => {
    render(<PermissionModeSelect session={{ id: 's', agent: 'claude', cwd: '/p', status: 'idle', permissionMode: 'default' }} />)
    const select = screen.getByLabelText('Permission mode')
    await userEvent.selectOptions(select, 'bypassPermissions')
    expect(api.setPermissionMode).not.toHaveBeenCalled()
    expect(select).toHaveValue('default')
    const confirm = screen.getByRole('group', { name: 'Confirm bypass permissions' })
    expect(confirm).toHaveTextContent(/won't ask/)
    // Claude takes this mode only at start: say why it will show detached.
    expect(confirm).toHaveTextContent(/restarts/)
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await userEvent.click(screen.getByRole('button', { name: 'Switch' }))
    expect(api.setPermissionMode).toHaveBeenCalledWith('s', 'bypassPermissions')
    expect(screen.queryByRole('group', { name: /confirm/ })).toBeNull()
  })

  it('stays in the asking mode when the switch is cancelled', async () => {
    render(<PermissionModeSelect session={{ id: 's', agent: 'codex', cwd: '/p', status: 'idle', permissionMode: 'auto' }} />)
    await userEvent.selectOptions(screen.getByLabelText('Permission mode'), 'full-access')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('group', { name: /confirm/ })).toBeNull()
    // Focus goes back where the question came from, not to the page.
    expect(screen.getByLabelText('Permission mode')).toHaveFocus()
    await userEvent.selectOptions(screen.getByLabelText('Permission mode'), 'full-access')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByLabelText('Permission mode')).toHaveFocus()
    expect(api.setPermissionMode).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Permission mode')).toHaveValue('auto')
  })

  it('reads the modes that never ask as dangerous', () => {
    const { rerender } = render(<PermissionModeSelect session={{ id: 's', agent: 'claude', cwd: '/p', status: 'idle', permissionMode: 'bypassPermissions' }} />)
    const select = screen.getByLabelText('Permission mode')
    expect(select).toHaveClass('mode-danger')
    expect(select.getAttribute('title')).toMatch(/won't ask/)
    rerender(<PermissionModeSelect session={{ id: 's', agent: 'codex', cwd: '/p', status: 'idle', permissionMode: 'full-access' }} />)
    expect(select).toHaveClass('mode-danger')
    rerender(<PermissionModeSelect session={{ id: 's', agent: 'codex', cwd: '/p', status: 'idle', permissionMode: 'auto' }} />)
    expect(select).not.toHaveClass('mode-danger')
    expect(select.getAttribute('title')).not.toMatch(/won't ask/)
  })
})
