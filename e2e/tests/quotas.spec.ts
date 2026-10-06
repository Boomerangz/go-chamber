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
