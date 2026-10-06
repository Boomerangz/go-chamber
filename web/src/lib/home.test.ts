import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('./api', () => ({ listFolders: vi.fn() }))
import { listFolders } from './api'
import { resetHome, useHome } from './home'

beforeEach(() => {
  vi.clearAllMocks()
  resetHome()
})

describe('useHome', () => {
  it('asks the server for the home folder once and shares it', async () => {
    ;(listFolders as Mock).mockResolvedValue({ path: '/Users/me', home: '/Users/me', folders: [] })
    const a = renderHook(() => useHome())
    const b = renderHook(() => useHome())
    expect(a.result.current).toBeUndefined()
    await waitFor(() => expect(a.result.current).toBe('/Users/me'))
    expect(b.result.current).toBe('/Users/me')
    renderHook(() => useHome())
    expect(listFolders).toHaveBeenCalledTimes(1)
  })

  it('stays unknown when the server cannot say, and asks again later', async () => {
    ;(listFolders as Mock).mockRejectedValueOnce(new Error('offline'))
    const a = renderHook(() => useHome())
    await waitFor(() => expect(listFolders).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(a.result.current).toBeUndefined()
    ;(listFolders as Mock).mockResolvedValue({ path: '/h', home: '/h', folders: [] })
    const b = renderHook(() => useHome())
    await waitFor(() => expect(b.result.current).toBe('/h'))
    expect(listFolders).toHaveBeenCalledTimes(2)
  })
})
