import { expect, test } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openNewSession } from './pane'

// Isolate the short idle timeout from other browser scenarios.
const token = 'codex-idle-token'
const repoRoot = path.resolve(process.cwd(), '..')
let server: ChildProcess | undefined
let base = ''
let bin = ''

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

test.beforeAll(async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'gc-codex-idle-')))
  bin = path.join(root, 'bin')
  const data = path.join(root, 'data')
  mkdirSync(bin)
  mkdirSync(path.join(data, 'claude'), { recursive: true })
  writeFileSync(path.join(data, 'token'), token)
  symlinkSync(path.join(repoRoot, 'bin', 'fakes', 'codex'), path.join(bin, 'codex'))
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  server = spawn(path.join(repoRoot, 'bin', 'go-chamber'), ['-addr', `127.0.0.1:${port}`, '-data', data, '-rtc-ice', '[]', '-codex-idle-timeout', '500ms'], {
    env: { HOME: root, SHELL: '/bin/sh', CLAUDE_CONFIG_DIR: path.join(data, 'claude'), PATH: `${bin}:/usr/bin:/bin` },
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
  throw new Error('the second server did not start')
})

test.afterAll(() => {
  server?.kill()
})

test('idle Codex unloads and resumes the same conversation', async ({ page }) => {
  await page.goto(`${base}/?token=${token}`)
  await openNewSession(page)
  await page.getByRole('radio', { name: 'Codex' }).click()
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await page.getByLabel('Message').fill('before idle')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.item.assistant', { hasText: 'echo: before idle' })).toBeVisible()
  const headers = { Authorization: `Bearer ${token}` }
  const sessions = async () => (await page.request.get(`${base}/api/sessions`, { headers })).json()
  const first = (await sessions())[0]
  await expect.poll(async () => (await sessions())[0].status).toBe('detached')
  await page.getByLabel('Message').fill('after idle')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.item.assistant', { hasText: 'echo: after idle' })).toBeVisible()
  expect((await sessions())[0].nativeId).toBe(first.nativeId)
  await expect(page.locator('.item.assistant', { hasText: 'echo: before idle' })).toBeVisible()
})
