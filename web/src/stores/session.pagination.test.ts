import { beforeEach, expect, it, vi } from 'vitest'
import type { HistoryPage, SessionEvent } from '../lib/api'
vi.mock('../lib/api', () => ({ fetchHistoryPage: vi.fn(), fetchEvents: vi.fn() }))
vi.mock('../lib/chime', () => ({ chimeOnEvent: vi.fn() }))
import * as api from '../lib/api'
import { resetStore, useSessionStore } from './session'

const store = () => useSessionStore.getState()
const message = (seq: number, id: string, text = id): SessionEvent => ({ seq, sessionId: 's', type: 'item.updated', item: { id, sessionId: 's', kind: 'assistant_message', status: 'completed', text } })
const page = (events: SessionEvent[], before = 0, hasMore = false): HistoryPage => ({ events, before, hasMore, lastSeq: events.at(-1)?.seq ?? 0 })
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('WebSocket', undefined)
  resetStore()
  vi.mocked(api.fetchEvents).mockResolvedValue([])
})

it('opens only the tail, prepends older items and preserves live updates and pagination on revisit', async () => {
  vi.mocked(api.fetchHistoryPage).mockResolvedValueOnce(page([message(10, 'b'), message(11, 'c')], 10, true))
  await store().selectSession('s')
  expect(api.fetchHistoryPage).toHaveBeenCalledWith('s', 0, expect.any(AbortSignal))
  expect(api.fetchEvents).not.toHaveBeenCalled()
  expect(store().chat.order).toEqual(['b', 'c'])
  let finish!: (value: HistoryPage) => void
  vi.mocked(api.fetchHistoryPage).mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
  const older = store().loadOlder()
  void store().loadOlder()
  store().applyIncoming(message(12, 'c', 'live'))
  finish(page([message(1, 'a'), message(9, 'b', 'old')], 1, false))
  await older
  expect(api.fetchHistoryPage).toHaveBeenCalledTimes(2)
  expect(store().chat.order).toEqual(['a', 'b', 'c'])
  expect(store().chat.items.b?.text).toBe('b')
  expect(store().chat.items.c?.text).toBe('live')
  expect(store().chat.historicalItems?.has('a')).toBe(true)
  expect(store().chat.historicalItems?.has('c')).toBe(false)
  expect(store().chat.lastSeq).toBe(12)
  expect(store().olderBefore).toBeNull()
  store().closeSession()
  await store().selectSession('s')
  expect(store().chat.order).toEqual(['a', 'b', 'c'])
  expect(api.fetchEvents).toHaveBeenLastCalledWith('s', 12, expect.any(AbortSignal))
  expect(store().olderBefore).toBeNull()
})

it('keeps the tail and cursor after an older page fails, retries, and ignores a page from another selection', async () => {
  vi.mocked(api.fetchHistoryPage).mockResolvedValueOnce(page([message(10, 'b')], 10, true))
  await store().selectSession('s')
  vi.mocked(api.fetchHistoryPage).mockRejectedValueOnce(new Error('offline'))
  await store().loadOlder()
  expect(store().history).toBe('ready')
  expect(store().olderError).toBe('offline')
  expect(store().olderBefore).toBe(10)
  let finish!: (value: HistoryPage) => void
  vi.mocked(api.fetchHistoryPage).mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
  const older = store().loadOlder()
  store().closeSession()
  vi.mocked(api.fetchHistoryPage).mockResolvedValueOnce(page([]))
  await store().selectSession('other')
  finish(page([message(1, 'a')]))
  await older
  expect(store().chat.order).toEqual([])
  expect(store().olderError).toBeNull()
})
