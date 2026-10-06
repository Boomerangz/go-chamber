import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession } from './pane'

// A user Stop hook that blocks makes the agent answer twice; the chat
// shows the hook between the answers and why it blocked.
for (const agent of ['Claude', 'Codex'] as const) {
  test(`shows a blocking Stop hook (${agent})`, async ({ page }) => {
    await page.goto(`/?token=${token}`)
    await openNewSession(page)
    await page.getByRole('radio', { name: agent }).click()
    await page.getByLabel('working directory').fill('/tmp')
    await page.getByRole('button', { name: 'New session', exact: true }).click()
    await page.getByLabel('message').fill('run the hook')
    await page.getByRole('button', { name: 'Send' }).click()

    const hook = page.locator('.item.hook', { hasText: 'Stop hook' })
    await expect(hook).toContainText('blocked')
    await expect(page.locator('.item.assistant', { hasText: 'checked after hook' })).toBeVisible()
    await hook.locator('summary').click()
    await expect(hook.locator('pre')).toHaveText('Check your work first.')
  })
}
