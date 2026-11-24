import { afterEach, expect, it, vi } from 'vitest'
import { allFonts, fontStack, knownFonts, type Measure } from './fonts'

// have fakes a client: fixed-width families measure the same for any text,
// the rest of the installed ones don't, unknown ones fall back to the base.
const have = (mono: string[], other: string[] = []): Measure => (font, text) => {
  const family = /^"(.+?)"/.exec(font)?.[1]
  if (family && mono.includes(family)) return 40
  if (family && other.includes(family)) return text.startsWith('i') ? 20 : 60
  return font.endsWith('serif') ? (text.startsWith('i') ? 10 : 30) : 50
}

afterEach(() => vi.unstubAllGlobals())

it('lists the well-known fixed-width fonts this client has', () => {
  expect(knownFonts(have(['Menlo', 'JetBrains Mono']))).toEqual(['JetBrains Mono', 'Menlo'])
  expect(knownFonts(have([]))).toEqual([])
})

it('lists nothing where text cannot be measured', () => {
  expect(knownFonts()).toEqual([])
})

it('asks the browser for every installed fixed-width font', async () => {
  const families = ['Zed Mono', 'Arial', 'Zed Mono', 'Iosevka'].map((family) => ({ family }))
  vi.stubGlobal('queryLocalFonts', vi.fn().mockResolvedValue(families))
  expect(await allFonts(have(['Zed Mono', 'Iosevka'], ['Arial']))).toEqual(['Iosevka', 'Zed Mono'])
})

it('has no full list when the browser cannot give one or is refused', async () => {
  expect(await allFonts(have([]))).toBeNull()
  vi.stubGlobal('queryLocalFonts', vi.fn().mockRejectedValue(new Error('denied')))
  expect(await allFonts(have([]))).toBeNull()
})

it('puts the chosen font ahead of the default ones', () => {
  expect(fontStack(null, 'monospace')).toBe('monospace')
  expect(fontStack('Fira "Code"', 'monospace')).toBe('"Fira \\"Code\\"", monospace')
})
