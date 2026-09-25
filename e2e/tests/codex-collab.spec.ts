import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { showPane } from './pane'

test('shows a codex collab subagent as a child session', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await page.getByLabel('agent').selectOption('codex')
  await page.getByLabel('working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session' }).click()
  await expect(page.getByLabel('message')).toBeVisible()

  await page.getByLabel('message').fill('start collab')
  await page.getByRole('button', { name: 'Send' }).click()

  await showPane(page, 'Sessions')
  const child = page.locator('.session-title', { hasText: 'child task' }).first()
  await expect(child).toBeVisible()
  await child.click()
  await expect(page.locator('.item.assistant', { hasText: 'child working' })).toBeVisible()
})
