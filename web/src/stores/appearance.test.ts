import { beforeEach, describe, expect, it } from 'vitest'
import { isDark, loadAppearance, resetAppearance, useAppearanceStore } from './appearance'

const store = () => useAppearanceStore.getState()
const root = () => document.documentElement.dataset

beforeEach(() => {
  localStorage.clear()
  resetAppearance()
})

describe('appearance store', () => {
  it('follows the system, at the default size and measure', () => {
    expect(loadAppearance()).toEqual({ theme: 'system', text: 'default', wide: false })
    expect(root().theme).toBeUndefined()
    expect(root().text).toBeUndefined()
    expect(root().wide).toBeUndefined()
  })

  it('sets each choice on the page and remembers it', () => {
    store().setTheme('dark')
    store().setText('large')
    store().setWide(true)
    expect(root()).toMatchObject({ theme: 'dark', text: 'large', wide: '' })
    expect(loadAppearance()).toEqual({ theme: 'dark', text: 'large', wide: true })
    store().setTheme('system')
    store().setText('default')
    store().setWide(false)
    expect(root().theme).toBeUndefined()
    expect(root().text).toBeUndefined()
    expect(root().wide).toBeUndefined()
  })

  it('ignores a stored value it does not know', () => {
    localStorage.setItem('gc.appearance', JSON.stringify({ theme: 'sepia', text: 'huge', wide: 'yes' }))
    expect(loadAppearance()).toEqual({ theme: 'system', text: 'default', wide: false })
    localStorage.setItem('gc.appearance', '{')
    expect(loadAppearance()).toEqual({ theme: 'system', text: 'default', wide: false })
  })

  it('reads a chosen theme over the system one', () => {
    store().setTheme('dark')
    expect(isDark()).toBe(true)
    store().setTheme('light')
    expect(isDark()).toBe(false)
  })
})
