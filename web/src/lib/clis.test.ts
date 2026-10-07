import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from './api'
import { missingCLIs, resetCLIs, useCLIs } from './clis'

vi.mock('./api', () => ({ listAgents: vi.fn() }))

beforeEach(() => {
  vi.resetAllMocks()
  resetCLIs()
})

describe('CLI availability', () => {
  it('assumes every CLI is there until the server says otherwise', () => {
    expect(missingCLIs(useCLIs.getState().clis)).toEqual([])
  })

  it('lists the agents whose CLI is missing', async () => {
    vi.mocked(api.listAgents).mockResolvedValue([
      { agent: 'claude', found: true, path: '/bin/claude' },
      { agent: 'codex', found: false, hint: 'npm install -g @openai/codex' },
    ])
    await useCLIs.getState().load()
    expect(missingCLIs(useCLIs.getState().clis)).toEqual(['codex'])
  })

  it('keeps what it knew when the server does not answer', async () => {
    vi.mocked(api.listAgents).mockRejectedValue(new Error('down'))
    await useCLIs.getState().load()
    expect(missingCLIs(useCLIs.getState().clis)).toEqual([])
  })
})
