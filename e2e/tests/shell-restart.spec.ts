import { expect, test } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Shells don't outlive go-chamber: after a restart the shells a tab knew
// are said to have ended, instead of vanishing. A server of its own, since
// the shared one can't be restarted.
const token = 'shell-restart-token'
const repoRoot = path.resolve(process.cwd(), '..')
let root = ''
let base = ''
let port = 0
let server: ChildProcess | undefined

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })
}

async function start() {
  server = spawn(path.join(repoRoot, 'bin', 'go-chamber'), ['-addr', `127.0.0.1:${port}`, '-data', path.join(root, 'data'), '-rtc-ice', '[]'], {
    env: { HOME: root, SHELL: '/bin/sh', PATH: '/usr/bin:/bin' },
    stdio: 'ignore',
  })
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${base}/api/health`)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error('the server did not start')
}

async function stop() {
  const s = server
  if (!s || s.exitCode !== null) return
  await new Promise<void>((resolve) => {
    s.once('exit', () => resolve())
    s.kill()
  })
}

test.beforeAll(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'gc-restart-')))
  mkdirSync(path.join(root, 'data'))
  writeFileSync(path.join(root, 'data', 'token'), token)
  port = await freePort()
  base = `http://127.0.0.1:${port}`
  await start()
})

test.afterAll(stop)

test('terminals a restart ended are said to have ended, until a new one opens', async ({ page, request }) => {
  const headers = { Authorization: `Bearer ${token}` }
  expect((await request.post(`${base}/api/terminals`, { headers, data: { cwd: root } })).status()).toBe(201)
  await page.goto(`${base}/terminal?token=${token}`)
  await expect(page.locator('.term-list [role="tab"]')).toHaveCount(1)
  await expect(page.getByRole('status', { name: 'Terminals ended' })).toHaveCount(0)

  await stop()
  await start()
  await page.reload()
  const note = page.getByRole('status', { name: 'Terminals ended' })
  await expect(note).toHaveText('1 terminal ended when go-chamber restarted')
  await expect(page.getByText('No terminals yet.')).toBeVisible()

  await page.getByRole('button', { name: 'New terminal', exact: true }).click()
  await expect(note).toHaveCount(0)
})
