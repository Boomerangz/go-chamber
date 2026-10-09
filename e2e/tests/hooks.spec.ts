import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { narrow, openNewSession, showPane } from './pane'

// A user Stop hook that blocks makes the agent answer twice; the chat
// shows the hook between the answers and why it blocked. A hook that ran
// silently takes no line until all hooks are asked for; with hooks off
// neither shows.
for (const agent of ['Claude', 'Codex'] as const) {
  test(`shows a blocking Stop hook (${agent})`, async ({ page }) => {
    await page.goto(`/?token=${token}`)
    await openNewSession(page)
    await page.getByRole('radio', { name: agent }).click()
    await page.getByLabel('Working directory').fill('/tmp')
    await page.getByRole('button', { name: 'New session', exact: true }).click()
    await page.getByLabel('Message').fill('run the hook')
    await page.getByRole('button', { name: 'Send' }).click()

    const hook = page.locator('.item.hook', { hasText: 'Stop hook' })
    await expect(hook).toContainText('blocked')
    await expect(page.locator('.item.assistant', { hasText: 'checked after hook' })).toBeVisible()
    await expect(page.locator('.item.hook')).toHaveCount(1)
    await hook.locator('summary').click()
    await expect(hook.locator('pre')).toHaveText('Check your work first.')

    // The setting sits in the sessions sidebar's footer, a pane of its own
    // on a phone.
    const hooks = page.getByRole('button', { name: 'Hooks' })
    const step = async () => {
      if (narrow(page)) await showPane(page, 'Sessions')
      await hooks.click()
      if (narrow(page)) await showPane(page, 'Chat')
    }
    await step()
    await expect(page.locator('.item.hook')).toHaveCount(2)
    await step()
    await expect(page.locator('.item.hook')).toHaveCount(0)
  })
}
