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
  // A hook on the subagent's command sits among its steps, not in the chat.
  await expect(page.locator('.subagent-items .item.hook')).toContainText('PreToolUse hook')
  await expect(page.locator('.items > li > .item.hook')).toHaveCount(0)
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
  // The turn records that the owner stopped it, in ink, not as a failure.
  await expect(page.locator('.turn-foot .stop-kw')).toHaveText('turn stopped')
  await expect(page.locator('.item-error')).toHaveCount(0)
})

// Stop also ends a turn that waits on a permission: the request is withdrawn.
test('stopping a turn withdraws its open permission', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await page.getByLabel('Message').fill('needs permission then stop')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.request-slot')).toHaveCount(1)
  const composer = page.locator('form.composer')
  await composer.getByRole('button', { name: 'Stop' }).click()
  await expect(composer.getByRole('button', { name: /^Stop/ })).toHaveCount(0)
  await expect(page.locator('.request-slot')).toHaveCount(0)
  await expect(page.locator('.turn-foot .stop-kw')).toHaveText('turn stopped')
})
