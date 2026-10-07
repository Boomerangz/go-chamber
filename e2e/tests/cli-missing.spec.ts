import { expect, test } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openNewSession } from './pane'

// A second go-chamber whose PATH has the Claude CLI but no Codex CLI: the
// shared server's PATH can't be changed while it runs.
const token = 'cli-missing-token'
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
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'gc-nocli-')))
  bin = path.join(root, 'bin')
  const data = path.join(root, 'data')
  mkdirSync(bin)
  mkdirSync(path.join(data, 'claude'), { recursive: true })
  writeFileSync(path.join(data, 'token'), token)
  symlinkSync(path.join(repoRoot, 'bin', 'fakes', 'claude'), path.join(bin, 'claude'))
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  server = spawn(path.join(repoRoot, 'bin', 'go-chamber'), ['-addr', `127.0.0.1:${port}`, '-data', data, '-rtc-ice', '[]'], {
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

test('a missing Codex CLI is said plainly, and Codex is not offered', async ({ page, request, isMobile }) => {
  test.skip(isMobile, 'the new-session form and accounts share the sidebar; one viewport covers them')
  const headers = { Authorization: `Bearer ${token}` }
  const refused = await request.post(`${base}/api/sessions`, { headers, data: { agent: 'codex', cwd: tmpdir() } })
  expect(refused.status()).toBe(422)
  expect(((await refused.json()) as { error: string }).error).toBe(
    'Codex CLI not found on PATH. Install it with npm install -g @openai/codex',
  )

  await page.goto(`${base}/?token=${token}`)
  await openNewSession(page)
  const codex = page.getByRole('radio', { name: 'Codex' })
  await expect(codex).toBeDisabled()
  await expect(codex).toHaveAttribute('title', /Codex CLI not found on PATH/)
  await expect(page.getByRole('radio', { name: 'Claude' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText('Codex CLI not found on PATH', { exact: true })).toBeVisible()
  await expect(page.getByText('npm install -g @openai/codex', { exact: true })).toBeVisible()
  await expect(page.getByText(/executable file not found/)).toHaveCount(0)

  await page.getByRole('radio', { name: 'Diagnostics' }).click()
  const serverPanel = page.getByRole('region', { name: 'Server diagnostics' })
  await expect(serverPanel).toContainText('Codex CLInot found on PATH')
  await expect(serverPanel).toContainText(/Claude Code CLI\/.*\/bin\/claude/)
})

// A Codex session made while its CLI was there says, once it is gone, what
// to install in the composer's place, before anything is sent.
test('an existing session whose CLI went missing says so in the composer’s place', async ({ page, request }, info) => {
  const headers = { Authorization: `Bearer ${token}` }
  const codex = path.join(bin, 'codex')
  symlinkSync(path.join(repoRoot, 'bin', 'fakes', 'codex'), codex)
  let made: { id: string }
  try {
    const res = await request.post(`${base}/api/sessions`, { headers, data: { agent: 'codex', cwd: tmpdir() } })
    expect(res.status()).toBe(201)
    made = (await res.json()) as { id: string }
    await request.post(`${base}/api/sessions/${made.id}/title`, { headers, data: { title: `no codex ${info.project.name}` } })
  } finally {
    rmSync(codex, { force: true })
  }

  await page.goto(`${base}/s/${made.id}?token=${token}`)
  const note = page.getByRole('group', { name: 'Codex CLI missing' })
  await expect(note).toBeVisible()
  await expect(page.getByLabel('Message')).toHaveCount(0)
  const install = note.locator('.cli-install code')
  await expect(install).toHaveText('npm install -g @openai/codex')
  expect(await install.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/mono/i)
  await expect(note.getByRole('button', { name: 'Copy install command' })).toBeVisible()
  expect(await note.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)

  // Installed, a check brings the composer back.
  symlinkSync(path.join(repoRoot, 'bin', 'fakes', 'codex'), codex)
  try {
    await note.getByRole('button', { name: 'Check again' }).click()
    await expect(page.getByLabel('Message')).toBeVisible()
    await expect(note).toHaveCount(0)
  } finally {
    rmSync(codex, { force: true })
  }
})
