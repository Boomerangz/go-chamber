import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Terminal } from '../lib/terminal'

vi.mock('../lib/terminal', () => ({
  listTerminals: vi.fn(),
  openTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  renameTerminal: vi.fn(),
}))

import * as api from '../lib/terminal'
import { resetTerminals, useTerminalStore } from './terminals'

const store = () => useTerminalStore.getState()

const term = (over: Partial<Terminal> = {}): Terminal => ({
  id: 't1', cwd: '/h', shell: '/bin/sh', title: 'h', status: 'running', exitCode: 0,
  createdAt: '2026-09-25T00:00:00Z', ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  resetTerminals()
})

describe('terminal store', () => {
  it('renames a terminal', async () => {
    ;(api.listTerminals as Mock).mockResolvedValue([term(), term({ id: 't2' })])
    await store().load()
    ;(api.renameTerminal as Mock).mockResolvedValue(term({ id: 't2', title: 'logs' }))
    await store().rename('t2', 'logs')
    expect(api.renameTerminal).toHaveBeenCalledWith('t2', 'logs')
    expect(store().terminals.map((t) => t.title)).toEqual(['h', 'logs'])
  })

  it('loads terminals without opening one on its own', async () => {
    ;(api.listTerminals as Mock).mockResolvedValue([term(), term({ id: 't2' })])
    await store().load()
    expect(store().terminals.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(store().activeId).toBeNull()
  })

  it('keeps a valid selection across loads', async () => {
    ;(api.listTerminals as Mock).mockResolvedValue([term(), term({ id: 't2' })])
    await store().load()
    store().select('t2')
    await store().load()
    expect(store().activeId).toBe('t2')

    ;(api.listTerminals as Mock).mockResolvedValue([term({ id: 't3' })])
    await store().load()
    expect(store().activeId).toBeNull()
  })

  it('restores the selection of this browser tab after a reload', async () => {
    ;(api.listTerminals as Mock).mockResolvedValue([term(), term({ id: 't2' })])
    await store().load()
    store().select('t2')
    resetTerminals()
    await store().load()
    expect(store().activeId).toBe('t2')
    expect(store().focusId).toBeNull()
  })

  it('works without session storage', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    ;(api.listTerminals as Mock).mockResolvedValue([term()])
    await store().load()
    store().select('t1')
    expect(store().activeId).toBe('t1')
    get.mockRestore()
    set.mockRestore()
  })

  it('records load errors', async () => {
    ;(api.listTerminals as Mock).mockRejectedValue(new Error('offline'))
    await store().load()
    expect(store().error).toBe('offline')
  })

  it('opens a terminal and selects it', async () => {
    ;(api.openTerminal as Mock).mockResolvedValue(term({ id: 'new', cwd: '/srv' }))
    await store().open({ cwd: '/srv' })
    expect(api.openTerminal).toHaveBeenCalledWith({ cwd: '/srv' })
    expect(store().terminals.map((t) => t.id)).toEqual(['new'])
    expect(store().activeId).toBe('new')
    expect(store().error).toBeNull()
  })

  it('records open errors', async () => {
    ;(api.openTerminal as Mock).mockRejectedValue(new Error('bad cwd'))
    await store().open({ cwd: 'x' })
    expect(store().error).toBe('bad cwd')
    expect(store().terminals).toEqual([])
  })

  it('closes a terminal and moves the selection', async () => {
    ;(api.listTerminals as Mock).mockResolvedValue([term(), term({ id: 't2' }), term({ id: 't3' })])
    await store().load()
    store().select('t2')
    ;(api.closeTerminal as Mock).mockResolvedValue(undefined)
    await store().close('t2')
    expect(api.closeTerminal).toHaveBeenCalledWith('t2')
    expect(store().terminals.map((t) => t.id)).toEqual(['t1', 't3'])
    expect(store().activeId).toBe('t1')

    await store().close('t3')
    expect(store().activeId).toBe('t1')
  })

  it('records close errors and keeps the terminal', async () => {
    ;(api.listTerminals as Mock).mockResolvedValue([term()])
    await store().load()
    ;(api.closeTerminal as Mock).mockRejectedValue(new Error('nope'))
    await store().close('t1')
    expect(store().error).toBe('nope')
    expect(store().terminals).toHaveLength(1)
  })

  it('marks a terminal exited', async () => {
    ;(api.listTerminals as Mock).mockResolvedValue([term(), term({ id: 't2' })])
    await store().load()
    store().markExited('t1', 3)
    expect(store().terminals[0]).toMatchObject({ status: 'exited', exitCode: 3 })
    expect(store().terminals[1].status).toBe('running')
  })

  it('focuses only terminals the user opened or selected', async () => {
    ;(api.listTerminals as Mock).mockResolvedValue([term(), term({ id: 't2' })])
    await store().load()
    expect(store().focusId).toBeNull()
    store().select('t2')
    expect(store().focusId).toBe('t2')
    ;(api.openTerminal as Mock).mockResolvedValue(term({ id: 't3' }))
    await store().open({})
    expect(store().focusId).toBe('t3')
  })

  it('keeps a terminal opened while a load was in flight', async () => {
    let finish: (v: Terminal[]) => void = () => {}
    ;(api.listTerminals as Mock).mockReturnValue(new Promise<Terminal[]>((r) => (finish = r)))
    const loading = store().load()
    ;(api.openTerminal as Mock).mockResolvedValue(term({ id: 'new' }))
    await store().open({})
    finish([term()])
    await loading
    expect(store().terminals.map((t) => t.id)).toEqual(['t1', 'new'])
    expect(store().activeId).toBe('new')
  })

  it('clears a stale error after successful load and close', async () => {
    ;(api.openTerminal as Mock).mockRejectedValue(new Error('bad'))
    await store().open({})
    ;(api.listTerminals as Mock).mockResolvedValue([term()])
    await store().load()
    expect(store().error).toBeNull()
    ;(api.openTerminal as Mock).mockRejectedValue(new Error('bad'))
    await store().open({})
    ;(api.closeTerminal as Mock).mockResolvedValue(undefined)
    await store().close('t1')
    expect(store().error).toBeNull()
  })
})
