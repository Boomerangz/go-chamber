import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession } from './pane'

async function startSession(page: import('@playwright/test').Page, text: string) {
  await openNewSession(page)
  await page.getByLabel('working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  // The previous chat stays on screen until the new one opens.
  await expect(page.locator('.chat-hint')).toBeVisible()
  await page.getByLabel('message').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText(`echo: ${text}`)).toBeVisible()
}

test('jumps between sessions from the keyboard', async ({ page, isMobile }) => {
  test.skip(isMobile, 'keyboard shortcuts are a desktop affordance')
  await page.goto(`/?token=${token}`)
  await startSession(page, 'shortcut alpha')
  await startSession(page, 'shortcut beta')

  await page.locator('.chat-header').click()
  await page.keyboard.press('ControlOrMeta+k')
  const go = page.getByRole('combobox', { name: 'Go to' })
  await expect(go).toBeFocused()
  await go.fill('alpha')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.item.user', { hasText: 'shortcut alpha' })).toBeVisible()

  // The opened chat focuses its composer; Escape leaves it for single keys.
  await page.keyboard.press('Escape')
  await page.keyboard.press('?')
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
