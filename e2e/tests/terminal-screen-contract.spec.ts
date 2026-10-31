import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

interface Fixture {
  name: string; cols: number; rows: number; before: string; after: string
  resizeCols?: number; resizeRows?: number
  replies?: number
  snapshot: { data: string; cols: number; rows: number }
  afterSnapshot: { data: string; cols: number; rows: number }
}

const root = path.resolve('..')
const fixtures = JSON.parse(execFileSync('go', ['run', './testutil/terminalscreen'], {
  cwd: root,
  input: fs.readFileSync(path.join(root, 'internal/adapters/terminalscreen/testdata/contracts.json')),
  encoding: 'utf8',
})) as Fixture[]

for (const fixture of fixtures) {
  test(`screen contract: ${fixture.name}`, async ({ page }) => {
    await page.goto('about:blank')
    await page.addScriptTag({ path: path.join(root, 'web/node_modules/@xterm/xterm/lib/xterm.js') })
    await page.addScriptTag({ path: path.join(root, 'web/node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js') })
    const result = await page.evaluate(async (f) => {
      // Use xterm's real parser and buffer, including input encoding modes.
      const globals = window as unknown as {
        Terminal: new (opts: object) => import('@xterm/xterm').Terminal
        Unicode11Addon: { Unicode11Addon: new () => import('@xterm/addon-unicode11').Unicode11Addon }
      }
      const make = (cols: number, rows: number) => {
        const t = new globals.Terminal({ cols, rows, allowProposedApi: true })
        t.loadAddon(new globals.Unicode11Addon.Unicode11Addon())
        t.unicode.activeVersion = '11'
        const host = document.createElement('div')
        document.body.appendChild(host)
        t.open(host)
        return t
      }
      const write = (t: import('@xterm/xterm').Terminal, data: string) => new Promise<void>((resolve) => t.write(data, resolve))
      const state = (t: import('@xterm/xterm').Terminal) => {
        const b = t.buffer.active
        return {
          cursor: [b.cursorX, b.cursorY], type: b.type, modes: t.modes,
          lines: Array.from({ length: t.rows }, (_, y) => {
            const line = b.getLine(b.baseY + y)!
            return Array.from({ length: t.cols }, (_, x) => {
              const c = line.getCell(x)!
              return [c.getChars() || ' ', c.getWidth(), c.getFgColorMode(), c.getFgColor(), c.getBgColorMode(), c.getBgColor(), c.isBold(), c.isUnderline(), c.isInverse()]
            })
          }),
        }
      }
      const original = make(f.cols, f.rows)
      await write(original, f.before)
      if (f.resizeCols) original.resize(f.resizeCols, f.resizeRows!)
      const restored = make(f.snapshot.cols, f.snapshot.rows)
      const clipboard: string[] = []
      restored.parser.registerOscHandler(52, (data) => { clipboard.push(data); return true })
      await write(restored, new TextDecoder().decode(Uint8Array.from(atob(f.snapshot.data), (c) => c.charCodeAt(0))))
      const replies: [string[], string[]] = [[], []]
      const responseReady = [original, restored].map((t, i) => new Promise<void>((resolve) => {
        t.onData((data) => { replies[i].push(data); if (replies[i].length >= (f.replies ?? 0)) resolve() })
        if (!f.replies) resolve()
      }))
      await write(original, f.after)
      await write(restored, f.after)
      await Promise.all(responseReady)
      const canonical = make(f.afterSnapshot.cols, f.afterSnapshot.rows)
      await write(canonical, new TextDecoder().decode(Uint8Array.from(atob(f.afterSnapshot.data), (c) => c.charCodeAt(0))))
      const value = { original: state(original), restored: state(restored), canonical: state(canonical), clipboard, replies }
      original.dispose(); restored.dispose(); canonical.dispose()
      return value
    }, fixture)
    expect(result.clipboard).toEqual([])
    expect(result.replies[1]).toEqual(result.replies[0])
    expect(result.restored).toEqual(result.original)
    expect(result.canonical).toEqual(result.original)
  })
}
