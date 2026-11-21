import { describe, expect, it } from 'vitest'
import { schemes, tokens, type Palette } from './schemes'

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const sheets = schemes.flatMap((s) => [
  [`${s.name} light`, s.light, false],
  [`${s.name} dark`, s.dark, true],
] as [string, Palette, boolean][])

describe('colour schemes', () => {
  it('have unique ids and a dark and a light palette each', () => {
    expect(new Set(schemes.map((s) => s.id)).size).toBe(schemes.length)
    expect(sheets).toHaveLength(schemes.length * 2)
  })

  it.each(sheets)('%s reads: text and signal colours clear 4.5:1 on the sheet', (_, p) => {
    for (const ink of [p.ink, p.ink2, p.ink3, p.act, p.req, p.bad]) expect(contrast(ink, p.paper)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(p.ink, p.paper3)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(p.actInk, p.act)).toBeGreaterThanOrEqual(4.5)
  })

  it.each(sheets)('%s keeps its sheets in order and its rules apart', (_, p, dark) => {
    expect(luminance(p.paper3) < luminance(p.paper)).toBe(!dark)
    expect(p.rule).not.toBe(p.paper)
    expect(p.ruleStrong).not.toBe(p.rule)
  })

  it('maps a palette onto the stylesheet tokens', () => {
    const t = tokens(schemes[0]!.dark)
    expect(t['--paper']).toBe(schemes[0]!.dark.paper)
    expect(t['--chevron']).toContain(schemes[0]!.dark.ink3.slice(1))
    expect(Object.keys(t)).toContain('--act-wash')
  })
})
