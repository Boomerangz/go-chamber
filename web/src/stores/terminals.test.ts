import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Terminal } from '../lib/terminal'

vi.mock('../lib/terminal', () => ({
  listTerminals: vi.fn(),
  openTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  renameTerminal: vi.fn(),
}))

import * as api from '../lib/terminal'
import { lastError, useNotices } from './notices'
import { FONT_MAX, FONT_MIN, openKey, resetTerminals, useTerminalStore } from './terminals'

const store = () => useTerminalStore.getState()

const term = (over: Partial<Terminal> = {}): Terminal => ({
  id: 't1', cwd: '/h', shell: '/bin/sh', title: 'h', status: 'running', exitCode: 0,
  createdAt: '2026-09-25T00:00:00Z', ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  resetTerminals()
  useNotices.setState({ notices: [] })
})

describe('terminal store', () => {
  it('keeps the exit status received before a delayed rename response', async () => {
    useTerminalStore.setState({ terminals: [term()] })
    let release: (v: Terminal) => void = () => {}
    ;(api.renameTerminal as Mock).mockReturnValueOnce(new Promise((r) => (release = r)))
    const pending = store().rename('t1', 'logs')
    store().markExited('t1', 7)
    release(term({ title: 'logs' }))
    await pending
    expect(store().terminals[0]).toMatchObject({ title: 'logs', status: 'exited', exitCode: 7 })
  })

  it('does not restore a closed terminal through a late rename during a reload', async () => {
    useTerminalStore.setState({ terminals: [term()] })
    let rename: (v: Terminal) => void = () => {}
    let list: (v: Terminal[]) => void = () => {}
    ;(api.renameTerminal as Mock).mockReturnValueOnce(new Promise((r) => (rename = r)))
    ;(api.listTerminals as Mock).mockReturnValueOnce(new Promise((r) => (list = r)))
    ;(api.closeTerminal as Mock).mockResolvedValueOnce(undefined)
    const pendingRename = store().rename('t1', 'logs')
    const pendingList = store().load()
    await store().close('t1')
    rename(term({ title: 'logs' }))
    await pendingRename
    list([term()])
    await pendingList
    expect(store().terminals).toEqual([])
  })

  it('does not duplicate an opened terminal already received in the terminal list', async () => {
    let release: (v: Terminal) => void = () => {}
    ;(api.openTerminal as Mock).mockReturnValueOnce(new Promise((r) => (release = r)))
    ;(api.listTerminals as Mock).mockResolvedValueOnce([term()])
    const pending = store().open({ cwd: '/h' })
    await store().load()
    release(term())
    await pending
    expect(store().terminals.map((t) => t.id)).toEqual(['t1'])
    expect(store().activeId).toBe('t1')
  })

  it('does not restore a terminal closed while its list was loading', async () => {
    useTerminalStore.setState({ terminals: [term()], activeId: 't1' })
    let release: (v: Terminal[]) => void = () => {}
    ;(api.listTerminals as Mock).mockReturnValueOnce(new Promise((r) => (release = r)))
    ;(api.closeTerminal as Mock).mockResolvedValueOnce(undefined)
    const pending = store().load()
    await store().close('t1')
    release([term()])
    await pending
    expect(store().terminals).toEqual([])
    expect(store().activeId).toBeNull()
  })

  it('keeps a rename made while the list was loading', async () => {
    useTerminalStore.setState({ terminals: [term()] })
    let release: (v: Terminal[]) => void = () => {}
    ;(api.listTerminals as Mock).mockReturnValueOnce(new Promise((r) => (release = r)))
    ;(api.renameTerminal as Mock).mockResolvedValueOnce(term({ title: 'logs' }))
    const pending = store().load()
    await store().rename('t1', 'logs')
    release([term()])
    await pending
    expect(store().terminals[0]!.title).toBe('logs')
  })

  it('keeps an exit received while the list was loading', async () => {
    useTerminalStore.setState({ terminals: [term()] })
    let release: (v: Terminal[]) => void = () => {}
    ;(api.listTerminals as Mock).mockReturnValueOnce(new Promise((r) => (release = r)))
    const pending = store().load()
    store().markExited('t1', 7)
    release([term()])
    await pending
    expect(store().terminals[0]).toMatchObject({ status: 'exited', exitCode: 7 })
  })

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

  it('records load errors and is not loaded until a list arrives', async () => {
    expect(store().loaded).toBe(false)
    ;(api.listTerminals as Mock).mockRejectedValue(new Error('offline'))
    await store().load()
    expect(store().loadError).toBe('offline')
    expect(store().loaded).toBe(false)
    ;(api.listTerminals as Mock).mockResolvedValue([])
    await store().load()
    expect(store().loadError).toBeNull()
    expect(store().loaded).toBe(true)
  })

  it('says when a requested terminal no longer exists', async () => {
    store().select('gone')
    ;(api.listTerminals as Mock).mockResolvedValue([term()])
    await store().load()
    expect(store().activeId).toBeNull()
    expect(store().missingId).toBe('gone')
    store().select('t1')
    expect(store().missingId).toBeNull()
  })

  it('is opening while the request is in flight and drops a second open', async () => {
    let release: (v: Terminal) => void = () => {}
    ;(api.openTerminal as Mock).mockReturnValueOnce(new Promise((r) => (release = r)))
    const first = store().open({ cwd: '/h' })
    expect(store().opening).toEqual({ 'cwd:/h': true })
    expect(await store().open({ cwd: '/h' })).toBe(false)
    expect(api.openTerminal).toHaveBeenCalledTimes(1)
    release(term())
    expect(await first).toBe(true)
    expect(store().opening).toEqual({})
  })

  it('marks a terminal closing until the close returns', async () => {
    useTerminalStore.setState({ terminals: [term()], activeId: 't1' })
    let release: () => void = () => {}
    ;(api.closeTerminal as Mock).mockReturnValueOnce(new Promise<void>((r) => (release = r)))
    const pending = store().close('t1')
    expect(store().closing).toEqual({ t1: true })
    expect(await store().close('t1')).toBe(false)
    release()
    await pending
    expect(store().closing).toEqual({})
  })

  it('keeps the connection state of each terminal', () => {
    store().setConnState('t1', 'reconnecting', 3)
    expect(store().conn.t1).toEqual({ state: 'reconnecting', attempt: 3 })
    store().setConnState('t1', 'live')
    expect(store().conn.t1).toEqual({ state: 'live', attempt: undefined })
  })

  it('reports rename failures as a notice', async () => {
    useTerminalStore.setState({ terminals: [term()] })
    ;(api.renameTerminal as Mock).mockRejectedValue(new Error('denied'))
    await store().rename('t1', 'x')
    expect(lastError()).toBe('denied')
  })

  it('opens a terminal and selects it', async () => {
    ;(api.openTerminal as Mock).mockResolvedValue(term({ id: 'new', cwd: '/srv' }))
    await store().open({ cwd: '/srv' })
    expect(api.openTerminal).toHaveBeenCalledWith({ cwd: '/srv' })
    expect(store().terminals.map((t) => t.id)).toEqual(['new'])
    expect(store().activeId).toBe('new')
    expect(store().openError).toBeNull()
  })

  it('records open errors next to the form until dismissed', async () => {
    ;(api.openTerminal as Mock).mockRejectedValue(new Error('bad cwd'))
    expect(await store().open({ cwd: 'x' })).toBe(false)
    expect(store().openError).toBe('bad cwd')
    expect(store().terminals).toEqual([])
    store().dismissOpenError()
    expect(store().openError).toBeNull()
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

  it('reports close errors and keeps the terminal', async () => {
    ;(api.listTerminals as Mock).mockResolvedValue([term()])
    await store().load()
    ;(api.closeTerminal as Mock).mockRejectedValue(new Error('nope'))
    expect(await store().close('t1')).toBe(false)
    expect(lastError()).toBe('nope')
    expect(store().terminals).toHaveLength(1)
    expect(store().closing).toEqual({})
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

  it('clears a stale open error once a terminal opens', async () => {
    ;(api.openTerminal as Mock).mockRejectedValue(new Error('bad'))
    await store().open({})
    ;(api.openTerminal as Mock).mockResolvedValue(term())
    await store().open({})
    expect(store().openError).toBeNull()
  })

  it('opens in two places at once, each busy on its own', async () => {
    let release: (v: Terminal) => void = () => {}
    ;(api.openTerminal as Mock).mockReturnValueOnce(new Promise((r) => (release = r))).mockResolvedValueOnce(term({ id: 't2' }))
    const first = store().open({ cwd: '/h' })
    expect(await store().open({ sessionId: 's1' })).toBe(true)
    expect(store().opening).toEqual({ 'cwd:/h': true })
    expect(openKey({})).toBe('home')
    expect(openKey({ sessionId: 's1' })).toBe('session:s1')
    release(term())
    await first
    expect(store().terminals.map((t) => t.id)).toEqual(['t2', 't1'])
  })

  it('renames at once and puts the old title back when the server refuses', async () => {
    useTerminalStore.setState({ terminals: [term()] })
    let refuse: (e: Error) => void = () => {}
    ;(api.renameTerminal as Mock).mockReturnValueOnce(new Promise((_, r) => (refuse = r)))
    const pending = store().rename('t1', 'logs')
    expect(store().terminals[0]!.title).toBe('logs')
    refuse(new Error('denied'))
    expect(await pending).toBe(false)
    expect(store().terminals[0]!.title).toBe('h')
  })

  it('replaces an exited shell in place with a new one under the same title', async () => {
    useTerminalStore.setState({
      terminals: [term({ id: 'a' }), term({ id: 't1', title: 'logs', status: 'exited', exitCode: 1 }), term({ id: 'c' })],
      activeId: 't1',
    })
    ;(api.openTerminal as Mock).mockResolvedValue(term({ id: 'n', title: 'h' }))
    ;(api.renameTerminal as Mock).mockResolvedValue(term({ id: 'n', title: 'logs' }))
    ;(api.closeTerminal as Mock).mockResolvedValue(undefined)
    expect(await store().reopen('t1')).toBe(true)
    expect(api.openTerminal).toHaveBeenCalledWith({ cwd: '/h' })
    expect(api.renameTerminal).toHaveBeenCalledWith('n', 'logs')
    expect(api.closeTerminal).toHaveBeenCalledWith('t1')
    expect(store().terminals.map((t) => [t.id, t.title])).toEqual([['a', 'h'], ['n', 'logs'], ['c', 'h']])
    expect(store().activeId).toBe('n')
    expect(store().opening).toEqual({})
  })

  it('keeps the exited shell when the new one fails to open', async () => {
    useTerminalStore.setState({ terminals: [term({ status: 'exited' })], activeId: 't1' })
    ;(api.openTerminal as Mock).mockRejectedValue(new Error('no shell'))
    expect(await store().reopen('t1')).toBe(false)
    expect(store().terminals.map((t) => t.id)).toEqual(['t1'])
    expect(store().openError).toBe('no shell')
    expect(api.closeTerminal).not.toHaveBeenCalled()
    expect(await store().reopen('missing')).toBe(false)
  })

  it('keeps the new shell when the old one can no longer be closed', async () => {
    useTerminalStore.setState({ terminals: [term({ status: 'exited' })], activeId: 't1' })
    ;(api.openTerminal as Mock).mockResolvedValue(term({ id: 'n' }))
    ;(api.closeTerminal as Mock).mockRejectedValue(new Error('gone'))
    expect(await store().reopen('t1')).toBe(true)
    expect(store().terminals.map((t) => t.id)).toEqual(['n'])
    expect(api.renameTerminal).not.toHaveBeenCalled()
  })

  it('remembers the font size, within bounds', () => {
    expect(store().fontSize).toBe(13)
    store().setFontSize(16)
    expect(store().fontSize).toBe(16)
    expect(localStorage.getItem('gc.terminal.fontSize')).toBe('16')
    store().setFontSize(100)
    expect(store().fontSize).toBe(FONT_MAX)
    store().setFontSize(1)
    expect(store().fontSize).toBe(FONT_MIN)
    store().setFontSize(null)
    expect(store().fontSize).toBe(13)
    expect(localStorage.getItem('gc.terminal.fontSize')).toBeNull()
  })

  it('reads a stored font size on reset', () => {
    localStorage.setItem('gc.terminal.fontSize', '15')
    resetTerminals()
    expect(store().fontSize).toBe(15)
    localStorage.setItem('gc.terminal.fontSize', 'big')
    resetTerminals()
    expect(store().fontSize).toBe(13)
    localStorage.removeItem('gc.terminal.fontSize')
  })

  it('opens the find bar of one terminal and tracks unseen output', () => {
    store().setFinding('t1', true)
    expect(store().finding).toBe('t1')
    store().setFinding('t2', false)
    expect(store().finding).toBe('t1')
    store().setFinding('t1', false)
    expect(store().finding).toBeNull()
    store().setUnseen('t1', true)
    expect(store().unseen).toEqual({ t1: true })
    store().setUnseen('t1', true)
    store().setUnseen('t1', false)
    expect(store().unseen).toEqual({})
  })

  it('focuses the next terminal after a close', async () => {
    useTerminalStore.setState({ terminals: [term(), term({ id: 't2' })], activeId: 't2', focusId: 't2' })
    ;(api.closeTerminal as Mock).mockResolvedValue(undefined)
    const tick = store().focusTick
    await store().close('t2')
    expect(store().focusId).toBe('t1')
    expect(store().focusTick).toBe(tick + 1)
  })
})
