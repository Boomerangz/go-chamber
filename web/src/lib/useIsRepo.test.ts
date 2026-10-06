import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from './api'
import { parentOf, useIsRepo } from './useIsRepo'

vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), listFolders: vi.fn() }))

const listing = (folders: api.Folder[]): api.FolderListing => ({ path: '/w', home: '/h', folders })

beforeEach(() => vi.mocked(api.listFolders).mockReset())

describe('parentOf', () => {
  it('splits an absolute path, trailing slash or not', () => {
    expect(parentOf('/w/app/')).toEqual({ parent: '/w', name: 'app' })
    expect(parentOf('/app')).toEqual({ parent: '/', name: 'app' })
    expect(parentOf('~/app')).toBeNull()
    expect(parentOf('/')).toBeNull()
  })
})

describe('useIsRepo', () => {
  it('asks the folder’s parent whether it is a repository', async () => {
    vi.mocked(api.listFolders).mockResolvedValue(listing([{ name: 'app', path: '/w/app', repo: true }, { name: 'notes', path: '/w/notes' }]))
    const { result, rerender } = renderHook(({ p }) => useIsRepo(p), { initialProps: { p: '/w/app' } })
    expect(result.current).toBeNull()
    await waitFor(() => expect(result.current).toBe(true))
    expect(api.listFolders).toHaveBeenCalledWith('/w', true)
    rerender({ p: '/w/notes' })
    expect(result.current).toBeNull()
    await waitFor(() => expect(result.current).toBe(false))
  })

  it('stays unknown when the folder isn’t listed or the server can’t say', async () => {
    vi.mocked(api.listFolders).mockResolvedValueOnce(listing([]))
    const { result, rerender } = renderHook(({ p }) => useIsRepo(p), { initialProps: { p: '/w/gone' } })
    await waitFor(() => expect(api.listFolders).toHaveBeenCalledTimes(1))
    expect(result.current).toBeNull()
    vi.mocked(api.listFolders).mockRejectedValueOnce(new Error('down'))
    rerender({ p: '/w/other' })
    await waitFor(() => expect(api.listFolders).toHaveBeenCalledTimes(2))
    expect(result.current).toBeNull()
  })

  it('doesn’t ask while disabled or for a relative path', async () => {
    renderHook(() => useIsRepo('/w/app', false))
    renderHook(() => useIsRepo('app'))
    await new Promise((r) => setTimeout(r, 350))
    expect(api.listFolders).not.toHaveBeenCalled()
  })
})
