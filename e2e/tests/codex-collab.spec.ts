import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

test('shows a codex collab subagent as a child session', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByRole('radio', { name: 'Codex' }).click()
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()

  await page.getByLabel('Message').fill('start collab')
  await page.getByRole('button', { name: 'Send' }).click()
  // The parent's line says what the child was asked; that is no output.
  const line = page.locator('.item.subagent').first()
  await expect(line.locator('.subagent-name')).toHaveText('subagent: child task')
  await expect(line.getByText('Output')).toHaveCount(0)

  await showPane(page, 'Sessions')
  const child = page.locator('.session-title', { hasText: 'child task' }).first()
  await expect(child).toBeVisible()
  await child.click()
  await expect(page.locator('.item.assistant', { hasText: 'child working' })).toBeVisible()
})
