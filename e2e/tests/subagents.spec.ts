import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'

test('stops a background subagent task', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await page.getByLabel('working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session' }).click()
  await expect(page.getByLabel('message')).toBeVisible()

  await page.getByLabel('message').fill('run a subagent')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.getByText('subagent: Task')).toBeVisible()
  await page.locator('.subagent .stop-task').click()
  await expect(page.locator('.subagent', { hasText: 'stopped by user' })).toBeVisible()
})
