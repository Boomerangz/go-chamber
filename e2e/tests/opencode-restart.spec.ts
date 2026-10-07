import { expect, test } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { token } from '../playwright.config'

// An independent backend is restarted here; the suite's shared server stays up.
test('OpenCode conversation resumes after backend and native server restart', async ({ page }) => {
  const root = path.resolve('..')
  const data = realpathSync(mkdtempSync(path.join(tmpdir(), 'oc-restart-')))
  writeFileSync(path.join(data, 'token'), token)
  const socket = createServer()
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve))
  const address = socket.address() as { port: number }
  await new Promise<void>((resolve) => socket.close(() => resolve()))
  const url = `http://127.0.0.1:${address.port}`
  let process: ChildProcess | undefined
  const start = async () => {
    process = spawn(path.join(root, 'bin/go-chamber'), ['-addr', `127.0.0.1:${address.port}`, '-data', data, '-rtc-ice', '[]'], {
      env: { ...globalThis.process.env, PATH: `${path.join(root, 'bin/fakes')}:${globalThis.process.env.PATH}`, FAKEOPENCODE_DATA: path.join(data, 'native') },
      stdio: 'ignore',
    })
    await expect.poll(async () => {
      try { return (await fetch(`${url}/api/health`, { headers: { Authorization: `Bearer ${token}` } })).status }
      catch { return 0 }
    }).toBe(200)
  }
  const stop = async () => {
    if (!process || process.exitCode !== null) return
    const exited = once(process, 'exit')
    process.kill('SIGTERM')
    await exited
  }
  try {
    await start()
    const response = await page.request.post(`${url}/api/sessions`, { headers: { Authorization: `Bearer ${token}` }, data: { agent: 'opencode', cwd: data } })
    expect(response.ok()).toBe(true)
    const { id } = await response.json()
    await page.goto(`${url}/s/${id}?token=${token}`)
    await page.getByLabel('Message').fill('before restart')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('echo: before restart', { exact: true })).toBeVisible()
    await expect(page.locator('.chat-meta .status')).toHaveText('idle')
    await stop()
    await start()
    await page.reload()
    await expect(page.getByText('echo: before restart', { exact: true })).toBeVisible()
    await page.getByLabel('Message').fill('after restart')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('echo: after restart', { exact: true })).toBeVisible()
    await expect(page.locator('.item.user', { hasText: 'before restart' })).toHaveCount(1)
    await expect(page.getByText('echo: before restart', { exact: true })).toHaveCount(1)
  } finally { await stop() }
})
