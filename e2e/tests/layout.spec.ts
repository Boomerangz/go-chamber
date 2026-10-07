import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { token } from '../playwright.config'
import { openNewSession, showPane, showSessionDetails } from './pane'

// A long unbreakable session title must be ellipsized, not widen the page
// (on mobile that zooms the whole UI out and shifts every control).
test('long session paths do not overflow the viewport', async ({ page }, info) => {
  const cwd = `/tmp/${'very-long-directory-name-'.repeat(6)}${info.project.name}`
  mkdirSync(cwd, { recursive: true })
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill(cwd)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  const width = page.viewportSize()!.width
  await showSessionDetails(page)
  await expect(page.locator('.chat-path', { hasText: cwd })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  await showPane(page, 'Sessions')
  await expect(page.locator(`.group-toggle[title="${cwd}"]`)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
})

// The page itself never scrolls: only its panes do. Something laid out
// past the window (an off-screen label escaping the sessions list) would
// let opening a session low in the list slide the whole app up.
test('opening a session low in a long list leaves the page where it is', async ({ page }) => {
  test.skip(page.viewportSize()!.width <= 720, 'a phone shows one pane at a time')
  const headers = { Authorization: `Bearer ${token}` }
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'gc-pagefit-')))
  const ids: string[] = []
  for (let i = 0; i < 20; i++) {
    const dir = path.join(base, `project-${i}`)
    mkdirSync(dir)
    const made = await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd: dir } })
    ids.push(((await made.json()) as { id: string }).id)
  }
  await page.goto(`/?token=${token}`)
  await page.goto(`/s/${ids[0]}`)
  await expect(page.getByLabel('Message')).toBeVisible()
  const page_ = () => page.evaluate(() => ({ top: document.scrollingElement!.scrollTop, over: document.scrollingElement!.scrollHeight - innerHeight }))
  expect(await page_()).toEqual({ top: 0, over: 0 })
  await page.mouse.move(200, 20)
  await page.mouse.wheel(0, 400)
  await page.waitForTimeout(100)
  expect((await page_()).top).toBe(0)
})
