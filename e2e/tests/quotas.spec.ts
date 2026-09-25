import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'

test('shows codex quota bars and session usage', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await page.getByLabel('agent').selectOption('codex')
  await page.getByLabel('working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session' }).click()
  await expect(page.getByLabel('message')).toBeVisible()

  await page.getByLabel('message').fill('hello')
  await page.getByRole('button', { name: 'Send' }).click()

  const quotas = page.getByLabel('Quotas', { exact: true })
  await expect(quotas).toContainText('primary')
  await expect(quotas).toContainText('25%')
  await expect(page.getByLabel('session usage')).toBeVisible()
})

test('shows claude quota bars', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await page.getByLabel('working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session' }).click()
  await expect(page.getByLabel('message')).toBeVisible()

  await page.getByLabel('message').fill('hi')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByLabel('Quotas', { exact: true })).toContainText('five hour')
})
