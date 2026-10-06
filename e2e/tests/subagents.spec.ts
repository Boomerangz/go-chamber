import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession } from './pane'

test('stops a background subagent task', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()

  await page.getByLabel('Message').fill('run a subagent')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.getByText('subagent: Task')).toBeVisible()
  await page.locator('.subagent .stop-task').click()
  await expect(page.locator('.subagent', { hasText: 'stopped by user' })).toBeVisible()
})

test('stopping the turn stops its foreground subagent', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await page.getByLabel('Message').fill('run a foreground subagent')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.subagent .stop-task')).toBeVisible()
  await page.locator('form.composer').getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('.subagent .stop-tag')).toHaveText('stopped')
  await expect(page.locator('.subagent .stop-task')).toHaveCount(0)
  await expect(page.locator('.subagent')).toHaveClass(/state-stopped/)
})
