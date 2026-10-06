import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { token } from '../playwright.config'
import { showPane } from './pane'

// The chat header keeps what names the session readable: the title before
// the usage line and the settings, a worktree's branch before its
// repository; an archived session says so.

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const headers = { Authorization: `Bearer ${token}` }

function newRepo(): string {
  // A long repository path: it used to push the branch out of the header.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'gc-e2e-')))
  const repo = path.join(root, 'clients', 'acme-corporation', 'projects', 'very-long-repository-name')
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env })
  writeFileSync(path.join(repo, 'README.md'), 'hello\n')
  execFileSync('git', ['add', '.'], { cwd: repo, env })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, env })
  return repo
}

const fits = (el: Element) => el.scrollWidth <= el.clientWidth + 1

test('a worktree header keeps its branch and its title readable beside a dock', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'a phone folds the header by its own rules')
  await page.setViewportSize({ width: 1280, height: 800 })
  const repo = newRepo()
  const res = await page.request.post('/api/worktrees', { headers, data: { agent: 'claude', cwd: repo, branch: `feature-x-${info.project.name}` } })
  const { id } = (await res.json()) as { id: string }
  await page.request.post(`/api/sessions/${id}/messages`, { headers, data: { text: 'Fix flaky tests in CI' } })
  await page.goto(`/s/${id}?token=${token}`)
  await expect(page.locator('.chat-heading h2')).toHaveText('Fix flaky tests in CI')
  await page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: /^Terminal/ }).click()
  await expect(page.locator('.layout[data-dock="terminal"]')).toBeVisible()
  const branch = page.locator('.chat-header .session-branch')
  await expect(branch).toHaveText(`feature-x-${info.project.name}`)
  expect(await branch.evaluate(fits)).toBe(true)
  await expect(page.locator('.chat-header .chat-repo')).toHaveText('very-long-repository-name')
  // The title keeps its whole width (it is short) before anything folds.
  expect(await page.locator('.chat-heading h2').evaluate(fits)).toBe(true)
  expect(await page.locator('.chat-header').evaluate(fits)).toBe(true)
})

test('an archived session says so in its header and comes back from there', async ({ page }, info) => {
  const res = await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd: '/tmp' } })
  const { id } = (await res.json()) as { id: string }
  await page.request.post(`/api/sessions/${id}/messages`, { headers, data: { text: `put away ${info.project.name}` } })
  await page.request.post(`/api/sessions/${id}/archive`, { headers })
  await page.goto(`/s/${id}?token=${token}`)
  await expect(page.locator('.chat-meta .archived-tag')).toHaveText('archived')
  const more = page.getByRole('button', { name: 'Session details' })
  if (await more.isVisible()) await more.click()
  await page.getByRole('button', { name: 'Unarchive' }).click()
  await expect(page.locator('.archived-tag')).toHaveCount(0)
  await showPane(page, 'Sessions')
  await expect(page.locator('.groups button.session', { hasText: `put away ${info.project.name}` })).toBeVisible()
})

test('the first-message hint wraps a long folder on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const deep = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'gc-e2e-'))), 'a-really-long-folder-name-without-any-breaks-at-all-whatsoever')
  mkdirSync(deep, { recursive: true })
  const res = await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd: deep } })
  const { id } = (await res.json()) as { id: string }
  await page.goto(`/s/${id}?token=${token}`)
  const hint = page.locator('.chat-hint')
  await expect(hint).toContainText('The agent runs in')
  expect(await page.locator('.chat .scroll').evaluate(fits)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
