import { describe, expect, it } from 'vitest'
import { tokenize } from './highlight'

const RED = /^#(d73a49|f97583|cf222e|ff7b72|b31d28|b3261e)/i

describe('tokenize', () => {
  it('keeps keywords and operators off red, which means failure here', async () => {
    const lines = await tokenize('func main() {\n\tif a == "" { return }\n}', 'go')
    const colours = lines!.flat().flatMap((t) => Object.values(t.htmlStyle ?? {}))
    expect(colours.length).toBeGreaterThan(0)
    expect(colours.filter((c) => RED.test(c))).toEqual([])
    const keyword = lines![0]!.find((t) => t.content === 'func')!
    expect(keyword.htmlStyle).toEqual({ '--shiki-light': '#45474d', '--shiki-dark': '#b3b1ab' })
  })

  it('leaves an unknown language alone', async () => {
    expect(await tokenize('x', 'cobol')).toBeUndefined()
  })
})
