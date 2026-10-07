import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

test('shows codex quota bars and session usage', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByRole('radio', { name: 'Codex' }).click()
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()

  await page.getByLabel('Message').fill('hello')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.getByLabel('Session usage')).toBeVisible()
  await showPane(page, 'Sessions')
  const quotas = page.getByLabel('Quotas', { exact: true })
  await expect(quotas).toContainText('5h window')
  await expect(quotas).toContainText('25%')
  await expect(quotas).toContainText('7d window')
})

test('shows claude quota bars', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()

  await page.getByLabel('Message').fill('hi')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.item.assistant').first()).toBeVisible()
  await showPane(page, 'Sessions')
  await expect(page.getByLabel('Quotas', { exact: true })).toContainText('5h window')
})

// The folded quota line names each agent by its letter box, so the window
// and its reset read whole at the narrow sidebar widths too.
test('the folded quota line reads its reset whole', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the phone sidebar is the full width')
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await page.getByLabel('Message').fill('hi')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.item.assistant').first()).toBeVisible()
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 })
    const when = page.locator('.quota-mini .quota-when').first()
    await expect(when).toBeVisible()
    await expect.poll(() => when.evaluate((el) => el.scrollWidth - el.clientWidth), { message: `${width}` }).toBeLessThanOrEqual(1)
  }
})
