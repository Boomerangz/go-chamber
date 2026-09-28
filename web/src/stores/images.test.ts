import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('../lib/api', () => ({ fetchEvents: vi.fn(), sendMessage: vi.fn() }))

import * as api from '../lib/api'
import { resetStore, useSessionStore } from './session'

const store = () => useSessionStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('WebSocket', undefined)
  resetStore()
  ;(api.sendMessage as Mock).mockResolvedValue(undefined)
})

describe('send with images', () => {
  it('sends images with the text, and images alone', async () => {
    useSessionStore.setState({ activeId: 'a' })
    await store().send('look', ['i1.png'])
    expect(api.sendMessage).toHaveBeenCalledWith('a', 'look', ['i1.png'])
    await store().send('', ['i2.png'])
    expect(api.sendMessage).toHaveBeenLastCalledWith('a', '', ['i2.png'])
    ;(api.sendMessage as Mock).mockClear()
    await store().send('  ')
    expect(api.sendMessage).not.toHaveBeenCalled()
  })
})
