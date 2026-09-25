import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../lib/api'
import { resetStore, useSessionStore } from '../../stores/session'
import { effortsFor, modelLabel } from '../../lib/models'
import ModelPicker from './ModelPicker'

vi.mock('../../lib/api', () => ({ listModels: vi.fn(), setModel: vi.fn() }))

const catalog: api.ModelInfo[] = [
  { id: 'big', name: 'Big', description: 'deep', efforts: ['low', 'high'], default: true },
  { id: 'fast', name: 'Fast', efforts: ['low'] },
  { id: 'tiny', name: 'Tiny' },
]

const session = (over: Partial<api.Session> = {}): api.Session => ({
  id: 's', agent: 'codex', cwd: '/p', status: 'idle', ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('WebSocket', undefined)
  resetStore()
  vi.mocked(api.listModels).mockResolvedValue(catalog)
  vi.mocked(api.setModel).mockImplementation(async (id, choice) => ({ ...session({ id }), ...choice }))
})

describe('effortsFor and modelLabel', () => {
  it('offers the chosen or default model efforts, else all of them', () => {
    expect(effortsFor(catalog, 'fast')).toEqual(['low'])
    expect(effortsFor(catalog, '')).toEqual(['low', 'high'])
    expect(effortsFor(catalog, 'tiny')).toEqual([])
    expect(effortsFor([{ id: 'a', name: 'A', efforts: ['x'] }, { id: 'b', name: 'B', efforts: ['x', 'y'] }], '')).toEqual(['x', 'y'])
    expect(effortsFor(catalog, 'unknown')).toEqual(['low', 'high'])
  })

  it('labels the choice', () => {
    expect(modelLabel(catalog, {})).toBe('Default model')
    expect(modelLabel(catalog, { model: 'big', effort: 'high' })).toBe('Big · high')
    expect(modelLabel(catalog, { model: 'gone' })).toBe('gone')
  })
})

describe('ModelPicker', () => {
  it('picks a model and an effort', async () => {
    render(<ModelPicker session={session()} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Model: Default model' }))
    expect(screen.getByText('From Codex config')).toBeInTheDocument()
    expect(screen.getByText('default')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: /Fast/ }))
    expect(api.setModel).toHaveBeenCalledWith('s', { model: 'fast', effort: '' })
    expect(api.listModels).toHaveBeenCalledWith('codex')
  })

  it('drops an effort the new model does not accept', async () => {
    useSessionStore.setState({ sessions: [session({ model: 'big', effort: 'high' })] })
    render(<ModelPicker session={session({ model: 'big', effort: 'high' })} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Model: Big · high' }))
    await userEvent.click(screen.getByRole('radio', { name: 'low' }))
    expect(api.setModel).toHaveBeenLastCalledWith('s', { model: 'big', effort: 'low' })
    expect(screen.queryByRole('dialog')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /Model:/ }))
    await userEvent.click(screen.getByRole('radio', { name: /Tiny/ }))
    expect(api.setModel).toHaveBeenLastCalledWith('s', { model: 'tiny', effort: '' })
  })

  it('does nothing when the choice is unchanged and hides effort for models without it', async () => {
    render(<ModelPicker session={session({ agent: 'claude', model: 'tiny' })} />)
    await userEvent.click(await screen.findByRole('button', { name: /Model:/ }))
    expect(screen.queryByRole('radiogroup', { name: 'effort' })).toBeNull()
    expect(screen.getByText('From Claude settings')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: /Tiny/ }))
    expect(api.setModel).not.toHaveBeenCalled()
  })

  it('closes on Escape and outside clicks', async () => {
    render(
      <div>
        <ModelPicker session={session()} />
        <p>outside</p>
      </div>,
    )
    const button = await screen.findByRole('button', { name: /Model:/ })
    await userEvent.click(button)
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    await userEvent.click(button)
    await userEvent.click(screen.getByRole('dialog'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await userEvent.click(screen.getByText('outside'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
