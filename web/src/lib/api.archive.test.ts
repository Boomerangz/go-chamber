import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, archiveSession, deleteSession, unarchiveSession } from './api'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl)
  vi.stubGlobal('fetch', fn)
  return fn
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('archive API', () => {
  it('archives and unarchives a session', async () => {
    const fn = stubFetch(async () => json({ id: 's a', archivedAt: '2026-10-06T09:00:00Z' }))
    expect(await archiveSession('s a')).toEqual({ id: 's a', archivedAt: '2026-10-06T09:00:00Z' })
    expect(fn.mock.calls[0]![0]).toBe('/api/sessions/s%20a/archive')
    expect(fn.mock.calls[0]![1]).toMatchObject({ method: 'POST' })
    await unarchiveSession('s a')
    expect(fn.mock.calls[1]![0]).toBe('/api/sessions/s%20a/unarchive')
    expect(fn.mock.calls[1]![1]).toMatchObject({ method: 'POST' })
  })

  it('deletes a session', async () => {
    const fn = stubFetch(async () => new Response(null, { status: 204 }))
    await deleteSession('s a')
    expect(fn.mock.calls[0]![0]).toBe('/api/sessions/s%20a')
    expect(fn.mock.calls[0]![1]).toMatchObject({ method: 'DELETE' })
    await deleteSession('s1', { removeWorktree: true })
    expect(fn.mock.calls[1]![0]).toBe('/api/sessions/s1?worktree=remove')
  })

  it('reports a refused delete', async () => {
    stubFetch(async () => json({ error: 's1: session is running: stop its turn first' }, 409))
    await expect(deleteSession('s1')).rejects.toMatchObject({ status: 409 })
    await expect(deleteSession('s1')).rejects.toBeInstanceOf(ApiError)
  })
})
