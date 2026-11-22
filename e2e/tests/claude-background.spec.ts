import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession } from './pane'

test('Claude follows up after a background command finishes', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await page.getByLabel('Message').fill('background lifecycle probe')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.item.assistant', { hasText: 'waiting for background work' })).toBeVisible()
  await expect(page.getByText('1 background task', { exact: true })).toBeVisible()
  await expect(page.locator('.item.assistant', { hasText: 'background work finished' })).toBeVisible({ timeout: 20000 })
  await expect(page.getByText('1 background task', { exact: true })).toHaveCount(0)
})
