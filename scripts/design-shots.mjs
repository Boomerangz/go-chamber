// design-shots — captures desktop/mobile, dark/light screenshots of a populated
// UI against the built binary and the fake CLIs. Used for design reviews.
// Usage: node scripts/design-shots.mjs <out-dir>
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const require = createRequire(path.join(root, 'e2e', 'package.json'))
const { chromium, devices } = require('@playwright/test')

const out = path.resolve(process.argv[2] ?? '.impeccable/review')
mkdirSync(out, { recursive: true })
const port = 7799
const token = 'shots'
const data = mkdtempSync(path.join(os.tmpdir(), 'gc-shots-'))
writeFileSync(path.join(data, 'token'), token)
const server = spawn(path.join(root, 'bin', 'go-chamber'), ['-addr', `127.0.0.1:${port}`, '-data', data], {
  env: { ...process.env, SHELL: '/bin/sh', PATH: `${path.join(root, 'bin', 'fakes')}:${process.env.PATH}` },
  stdio: 'ignore',
})
const base = `http://127.0.0.1:${port}`
for (let i = 0; i < 50; i++) {
  try { await fetch(`${base}/api/health`); break } catch { await new Promise((r) => setTimeout(r, 200)) }
}

const browser = await chromium.launch()
try {
  // Populate once on desktop: sessions persist in the data dir.
  const seed = await browser.newPage()
  seed.on('pageerror', (e) => console.error('pageerror:', e.message))
  seed.on('console', (m) => m.type() === 'error' && console.error('console:', m.text()))
  await seed.goto(`${base}/?token=${token}`)
  async function session(dir, messages) {
    await seed.getByLabel('working directory').fill(dir)
    await seed.getByRole('button', { name: 'New session', exact: true }).click()
    await seed.locator('.chat-hint').waitFor()
    for (const m of messages) {
      const allow = m.endsWith('!')
      await seed.getByLabel('message').fill(allow ? m.slice(0, -1) : m)
      await seed.getByRole('button', { name: 'Send' }).click()
      await seed.waitForTimeout(900)
      if (allow) {
        await seed.getByRole('button', { name: 'Allow', exact: true }).click()
        await seed.waitForTimeout(900)
      }
    }
  }
  await session('/tmp', ['hello', 'bash it'])
  await session('/usr', ['run a subagent please'])
  await session('/tmp', ['hello — привет, проверим кириллицу', 'bash it', 'please permission!', 'hook it', 'please permission'])
  const url = seed.url()
  await seed.close()

  const views = [
    ['desktop', { viewport: { width: 1440, height: 900 } }],
    ['mobile', { ...devices['Pixel 7'] }],
  ]
  for (const [name, opts] of views) {
    for (const scheme of ['dark', 'light']) {
      const ctx = await browser.newContext({ ...opts, colorScheme: scheme, reducedMotion: 'reduce' })
      const page = await ctx.newPage()
      await page.goto(url.includes('token=') ? url : `${url}${url.includes('?') ? '&' : '?'}token=${token}`)
      await page.waitForTimeout(600)
      const bar = page.getByRole('navigation', { name: 'Views' })
      if (await bar.isVisible()) await bar.getByRole('button', { name: /^Sessions/ }).click()
      await page.locator('.session-title', { hasText: 'кириллицу' }).click({ timeout: 5000 }).catch(async (e) => {
        await page.screenshot({ path: path.join(out, `${name}-${scheme}-FAILED.png`) })
        throw e
      })
      await page.waitForTimeout(1200)
      await page.screenshot({ path: path.join(out, `${name}-${scheme}.png`) })
      if (name === 'mobile') {
        for (const pane of ['Sessions', 'Requests']) {
          await bar.getByRole('button', { name: new RegExp(`^${pane}`) }).click()
          await page.waitForTimeout(400)
          await page.screenshot({ path: path.join(out, `${name}-${scheme}-${pane.toLowerCase()}.png`) })
        }
      }
      await ctx.close()
    }
  }
} finally {
  await browser.close()
  server.kill()
}
console.log(`screenshots in ${out}`)
