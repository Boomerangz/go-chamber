import { expect, test, type Page } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession } from './pane'

async function newSession(page: Page) {
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()
}

// Answered with A, a permission hands focus to the transcript, not the
// composer: the next single keys stay shortcuts instead of becoming text.
test('a keyboard answer leaves the keys as shortcuts', async ({ page, isMobile }) => {
  test.skip(isMobile, 'a phone has no keyboard shortcuts')
  await newSession(page)
  await page.getByLabel('Message').fill('please permission')
  await page.getByLabel('Message').press('Enter')
  const card = page.locator('.request.permission')
  await expect(card).toBeFocused()
  // The card ignores keys for a moment after taking focus from the composer.
  await page.waitForTimeout(700)
  await page.keyboard.press('a')
  await expect(page.locator('.item.assistant', { hasText: /approved: run/ })).toBeVisible()
  await expect(page.locator('.chat > .scroll')).toBeFocused()
  await page.keyboard.type('xyz')
  await expect(page.getByLabel('Message')).toHaveValue('')
})

// On a phone, a chat field with the keyboard up marks the page and keeps
// only the header's title row; no request card is focused on its own.
test('typing on a phone makes room for the transcript', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the on-screen keyboard is a phone matter')
  await newSession(page)
  const header = page.locator('.chat-header')
  const tall = (await header.boundingBox())!.height
  await page.getByLabel('Message').fill('ask me something')
  await page.getByRole('button', { name: 'Send' }).click()
  const card = page.locator('.request.question')
  await expect(card).toBeVisible()
  // Arrival focuses nothing on touch: no ring before the owner taps.
  expect(await page.evaluate(() => document.activeElement?.closest('.request') == null)).toBe(true)
  const other = card.getByPlaceholder('Other…').first()
  await other.focus()
  await expect(page.locator('html')).toHaveAttribute('data-typing', 'chat')
  await expect(header.locator('.chat-meta')).toBeHidden()
  expect((await header.boundingBox())!.height).toBeLessThan(tall)
  await expect(other).toBeInViewport()
  await other.blur()
  await expect(page.locator('html')).not.toHaveAttribute('data-typing', 'chat')
  await expect(header.locator('.chat-meta')).toBeVisible()
})

// The composer with the keyboard up hides the pane bar; it is back on blur.
test('the pane bar steps aside while the composer has focus on a phone', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the on-screen keyboard is a phone matter')
  await newSession(page)
  const bar = page.getByRole('navigation', { name: 'Views' })
  await expect(bar).toBeVisible()
  await page.getByLabel('Message').focus()
  await expect(page.locator('html')).toHaveAttribute('data-typing', 'chat')
  await expect(bar).toBeHidden()
  await page.getByLabel('Message').blur()
  await expect(page.locator('html')).not.toHaveAttribute('data-typing', 'chat')
  await expect(bar).toBeVisible()
})
