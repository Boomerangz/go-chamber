import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'

// A long unbreakable session title must be ellipsized, not widen the page
// (on mobile that zooms the whole UI out and shifts every control).
test('long session paths do not overflow the viewport', async ({ page }, info) => {
  const cwd = `/tmp/${'very-long-directory-name-'.repeat(6)}${info.project.name}`
  await page.goto(`/?token=${token}`)
  await page.getByLabel('working directory').fill(cwd)
  await page.getByRole('button', { name: 'New session' }).click()
  await expect(page.getByRole('button', { name: new RegExp(cwd) })).toBeVisible()
  const width = page.viewportSize()!.width
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
})
