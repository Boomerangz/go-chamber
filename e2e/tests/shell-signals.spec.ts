import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { token } from '../playwright.config'
import { showPane } from './pane'

const headers = { Authorization: `Bearer ${token}` }
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }

function newRepo(): string {
  const repo = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'gc-sig-'))), 'app')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env })
  writeFileSync(path.join(repo, 'README.md'), 'hello\n')
  execFileSync('git', ['add', '.'], { cwd: repo, env })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, env })
  return repo
}

test('what waits for the owner shows on the Agents tab in another mode', async ({ page }) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'gc-wait-')))
  const { id } = (await (await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd: dir } })).json()) as { id: string }
  await page.goto(`/s/${id}?token=${token}`)
  await page.getByLabel('Message').fill('ask me something')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('legend', { hasText: 'Which option should we use?' })).toBeVisible()
  const agents = page.getByRole('radio', { name: 'Agents', exact: true })
  await expect(agents.locator('.badge')).toHaveCount(0)
  await page.getByRole('radio', { name: /^Terminal/ }).click()
  await expect(agents.locator('.badge')).toBeVisible()
  await expect(agents).toHaveAttribute('title', /waiting for you/)
})

test('a blocked bell says where to unblock it', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the bell sits in the desktop top bar')
  await page.addInitScript(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'denied' })
    Notification.requestPermission = async () => 'denied'
  })
  await page.goto(`/?token=${token}`)
  const bell = page.getByRole('button', { name: 'Notifications' })
  await expect(bell).toHaveAttribute('title', 'Blocked in browser site settings')
  await expect(bell).toBeEnabled()
  await bell.click()
  await expect(page.locator('.notices')).toContainText(/site settings/)
})

test('on a phone, Back from Changes returns to the chat', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'one pane at a time is a phone layout')
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'gc-back-')))
  const { id } = (await (await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd: dir } })).json()) as { id: string }
  await page.goto(`/s/${id}?token=${token}`)
  await expect(page.getByLabel('Message')).toBeVisible()
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: /^Changes/ }).click()
  await expect(page.getByRole('region', { name: 'Changes' })).toBeVisible()
  await page.goBack()
  await expect(page.getByLabel('Message')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/s/${id}`))
})

test('on a phone, the pane bar steps aside while the owner types', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the pane bar is a phone layout')
  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  const bar = page.getByRole('navigation', { name: 'Views' })
  await expect(bar).toBeVisible()
  await page.getByPlaceholder('Search sessions').focus()
  await expect(bar).toBeHidden()
  await page.getByPlaceholder('Search sessions').blur()
  await expect(bar).toBeVisible()
  // The chat marks typing on the root while its fields have the focus.
  await page.evaluate(() => (document.documentElement.dataset.typing = 'chat'))
  await expect(bar).toBeHidden()
  await page.evaluate(() => delete document.documentElement.dataset.typing)
  await expect(bar).toBeVisible()
})

test('at 360px the top bar keeps its gutter and every mode in view', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'a phone width')
  await page.setViewportSize({ width: 360, height: 760 })
  await page.goto(`/?token=${token}`)
  const fit = await page.evaluate(() => {
    const word = document.querySelector('.mode-switch [role="radio"]')!
    const range = document.createRange()
    range.selectNodeContents(word.firstChild!)
    const sw = document.querySelector<HTMLElement>('.mode-switch')!
    return { textLeft: range.getBoundingClientRect().left, scrolls: sw.scrollWidth - sw.clientWidth, end: document.querySelector('.topbar-end')!.getBoundingClientRect().right }
  })
  expect(fit.textLeft).toBeGreaterThanOrEqual(13)
  expect(fit.scrolls).toBeLessThanOrEqual(0)
  expect(fit.end).toBeLessThanOrEqual(360)
})

test('a shell opens in a live worktree from the terminal Projects', async ({ page }, info) => {
  const repo = newRepo()
  const branch = `shell-${info.project.name}`
  const res = await page.request.post('/api/worktrees', { headers, data: { agent: 'claude', cwd: repo, branch } })
  const { worktree } = (await res.json()) as { worktree: { path: string } }
  await page.goto(`/terminal?token=${token}`)
  const chip = page.getByRole('button', { name: `Open terminal in app ⎇ ${branch}` })
  await expect(chip).toHaveAttribute('title', worktree.path)
  await chip.click()
  const screen = page.getByTestId('terminal-view')
  await screen.click()
  await page.keyboard.type('pwd\n')
  await expect(screen.locator('.xterm-rows')).toContainText(worktree.path)
})
