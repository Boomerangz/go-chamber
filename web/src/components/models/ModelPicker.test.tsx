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
    // One default: the Default choice names the model it stands for.
    expect(screen.getByText('Big, from Codex config')).toBeInTheDocument()
    expect(screen.queryByText('default')).toBeNull()
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
    expect(screen.queryByRole('radiogroup', { name: 'Effort' })).toBeNull()
    expect(screen.getByText('Big, from Claude settings')).toBeInTheDocument()
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

  it('shows the chosen model at once, unsettled, until the server agrees', async () => {
    let release: (s: api.Session) => void = () => {}
    vi.mocked(api.setModel).mockImplementation((id, choice) => new Promise((r) => (release = () => r({ ...session({ id }), ...choice }))))
    useSessionStore.setState({ sessions: [session()] })
    const { rerender } = render(<ModelPicker session={session()} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Model: Default model' }))
    await userEvent.click(screen.getByRole('radio', { name: /Fast/ }))
    const button = screen.getByRole('button', { name: 'Model: Fast' })
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveFocus()
    release(session())
    await vi.waitFor(() => expect(button).not.toHaveAttribute('aria-busy'))
    rerender(<ModelPicker session={useSessionStore.getState().sessions[0]!} />)
    expect(screen.getByRole('button', { name: 'Model: Fast' })).toBeInTheDocument()
  })

  it('goes back to the old model when the change fails', async () => {
    vi.mocked(api.setModel).mockRejectedValue(new Error('nope'))
    render(<ModelPicker session={session({ model: 'big' })} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Model: Big' }))
    await userEvent.click(screen.getByRole('radio', { name: /Fast/ }))
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Model: Big' })).not.toHaveAttribute('aria-busy'))
  })

  it('says when models are loading and when the agent lists none', async () => {
    let finish: (m: api.ModelInfo[]) => void = () => {}
    vi.mocked(api.listModels).mockImplementation(() => new Promise((r) => (finish = r)))
    render(<ModelPicker session={session()} />)
    await userEvent.click(screen.getByRole('button', { name: /Model:/ }))
    expect(screen.getByText('loading models…')).toBeInTheDocument()
    finish([])
    expect(await screen.findByText("this agent doesn't list models")).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Default/ })).toBeInTheDocument()
  })

  it('says the listing failed, with a retry that shows it loading again', async () => {
    vi.mocked(api.listModels).mockRejectedValueOnce(new Error('codex stopped')).mockRejectedValueOnce(new Error('codex stopped'))
    render(<ModelPicker session={session()} />)
    await userEvent.click(screen.getByRole('button', { name: /Model:/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load models: codex stopped")
    expect(screen.queryByText("this agent doesn't list models")).toBeNull()
    let finish: (m: api.ModelInfo[]) => void = () => {}
    vi.mocked(api.listModels).mockImplementationOnce(() => new Promise((r) => (finish = r)))
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(screen.getByText('loading models…')).toBeInTheDocument()
    finish(catalog)
    expect(await screen.findByRole('radio', { name: /Fast/ })).toBeInTheDocument()
  })

  it('moves focus into the menu, walks it with arrows and returns it on Escape', async () => {
    render(<ModelPicker session={session({ model: 'fast', effort: 'low' })} />)
    const button = await screen.findByRole('button', { name: /Model:/ })
    await screen.findByText(/Fast/)
    await userEvent.click(button)
    const fast = screen.getByRole('radio', { name: /Fast/ })
    expect(fast).toHaveFocus()
    expect(fast).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('radio', { name: /Tiny/ })).toHaveAttribute('tabindex', '-1')
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('radio', { name: /Tiny/ })).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('radio', { name: /Default/ })).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}')
    expect(screen.getByRole('radio', { name: /Tiny/ })).toHaveFocus()
    await userEvent.keyboard('{End}')
    expect(screen.getByRole('radio', { name: /Tiny/ })).toHaveFocus()
    await userEvent.keyboard('{Home}')
    expect(screen.getByRole('radio', { name: /Default/ })).toHaveFocus()
    // effort is its own group
    screen.getByRole('radio', { name: 'low' }).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'auto' })).toHaveFocus()
    expect(api.setModel).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(button).toHaveFocus()
  })
})
