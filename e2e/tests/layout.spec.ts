import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { showPane } from './pane'

// A long unbreakable session title must be ellipsized, not widen the page
// (on mobile that zooms the whole UI out and shifts every control).
test('long session paths do not overflow the viewport', async ({ page }, info) => {
  const cwd = `/tmp/${'very-long-directory-name-'.repeat(6)}${info.project.name}`
  await page.goto(`/?token=${token}`)
  await page.getByLabel('working directory').fill(cwd)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  const width = page.viewportSize()!.width
  await expect(page.locator('.chat-path', { hasText: cwd })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  await showPane(page, 'Sessions')
  await expect(page.getByRole('button', { name: new RegExp(cwd) })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
})
