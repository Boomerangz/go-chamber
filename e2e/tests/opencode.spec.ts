import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { token } from '../playwright.config'
import { openNewSession, showSessionDetails } from './pane'

const headers = { Authorization: `Bearer ${token}` }
test('OpenCode models, tools, requests, fork and reload', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByRole('radio', { name: 'OpenCode', exact: true }).click()
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()
  await showSessionDetails(page)
  await expect(page.getByLabel('Permission mode')).toHaveCount(0)
  await expect(page.getByLabel('Approval reviewer')).toHaveCount(0)
  await page.getByRole('button', { name: 'Model: Default model' }).click()
  await page.getByRole('searchbox', { name: 'Search models' }).fill('openrouter')
  await page.getByRole('radio', { name: /^Test model/ }).click()
  await page.getByRole('button', { name: 'Model: Test model' }).click()
  await page.getByRole('radio', { name: 'high', exact: true }).click()
  const send = async (text: string) => {
    await page.getByLabel('Message').fill(text)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
  }
  await send('tools')
  await expect(page.getByText('echo: tools', { exact: true })).toBeVisible()
  await expect(page.locator('.chat-meta .status')).toHaveText('idle')
  await expect(page.locator('.usage')).toContainText('$0.0100')
  await send('permission')
  await page.locator('.chat .request').getByRole('button', { name: /Allow for session/ }).click()
  await expect(page.locator('.item.assistant').getByText('approved', { exact: true })).toBeVisible()
  await send('question')
  const ask = page.locator('.chat .request.question')
  await ask.getByLabel('Alpha', { exact: false }).check()
  await ask.getByLabel('Beta', { exact: false }).check()
  await ask.getByRole('button', { name: /Submit/ }).click()
  await expect(ask).toHaveCount(0)
  await expect(page.locator('.chat-meta .status')).toHaveText('idle')
  await page.reload()
  await expect(page.getByText('echo: tools', { exact: true })).toBeVisible()
  await showSessionDetails(page)
  const previous = page.url()
  await page.getByRole('button', { name: 'Fork', exact: true }).click()
  await page.getByRole('button', { name: 'Create fork', exact: true }).click()
  await expect(page).not.toHaveURL(previous)
  await expect(page.getByRole('heading', { name: 'tools (fork)', exact: true })).toBeVisible()
  await expect(page.getByLabel('Message')).toHaveValue('')
  await expect(page.getByText('echo: tools', { exact: true })).toBeVisible()
  await send('branched')
  await expect(page.getByText('echo: branched', { exact: true })).toBeVisible()
  await expect(page.locator('.item.user', { hasText: 'branched' })).toHaveCount(1)
})

test('OpenCode native abort and continue in a worktree', async ({ page }, info) => {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'gc-oc-')))
  const env = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test' }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env })
  writeFileSync(path.join(repo, 'test.txt'), 'original\n')
  execFileSync('git', ['add', '.'], { cwd: repo, env })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo, env })
  const res = await page.request.post('/api/worktrees', { headers, data: { agent: 'opencode', cwd: repo, branch: `oc-${info.project.name}` } })
  expect(res.ok()).toBe(true)
  const session = await res.json()
  await page.goto(`/s/${session.id}?token=${token}`)
  await page.getByLabel('Message').fill('child')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(page.locator('.chat-meta .status')).toHaveText('idle')
  await page.getByLabel('Message').fill('continue')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('echo: continue', { exact: true })).toBeVisible()
  await expect(page.locator('.chat-meta .status')).toHaveText('idle')
})
