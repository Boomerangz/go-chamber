import { expect, test, type Page } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession } from './pane'

async function newSession(page: Page, agent: 'Claude' | 'Codex') {
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByRole('radio', { name: agent }).click()
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()
}

// At 1440 with no dock open both agents show their settings inline: Codex's
// mode and approvals are no longer folded behind "⋯" while Claude's show.
for (const agent of ['Claude', 'Codex'] as const) {
  test(`${agent} shows its settings inline at 1440px`, async ({ page, isMobile }) => {
    test.skip(isMobile, 'a phone folds by its own rules')
    await page.setViewportSize({ width: 1440, height: 900 })
    await newSession(page, agent)
    await page.getByLabel('Message').fill('hello header')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.locator('.item.assistant', { hasText: 'echo: hello header' })).toBeVisible()
    const header = page.locator('.chat-header')
    await expect(header).not.toHaveAttribute('data-fold')
    await expect(page.getByRole('button', { name: 'Session details' })).toBeHidden()
    await expect(page.getByLabel('Permission mode')).toBeVisible()
    if (agent === 'Codex') await expect(page.getByLabel('Approval reviewer')).toBeVisible()
    expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  })
}
