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
    const select = screen.getByLabelText('permission mode')
    expect(select).toHaveValue('plan')
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('value'))).toEqual(['', 'default', 'acceptEdits', 'plan', 'bypassPermissions'])
    await userEvent.selectOptions(select, 'acceptEdits')
    expect(api.setPermissionMode).toHaveBeenCalledWith('s', 'acceptEdits')
  })

  it('offers the Codex presets', () => {
    render(<PermissionModeSelect session={{ id: 's', agent: 'codex', cwd: '/p', status: 'idle' }} />)
    expect(screen.getByLabelText('permission mode')).toHaveValue('')
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('value'))).toEqual(['', 'read-only', 'auto', 'full-access'])
  })
})
