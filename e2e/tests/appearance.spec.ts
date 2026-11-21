import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

test('Settings set the sheet, the colour scheme, the transcript size and its width, and keeps them', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()
  await page.getByLabel('Message').fill('hello')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const reply = page.locator('.item.assistant', { hasText: 'echo: hello' })
  await expect(reply).toBeVisible()
  const paper = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  const size = () => reply.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
  const width = () => reply.evaluate((el) => el.getBoundingClientRect().width)
  const light = await paper()
  const before = { size: await size(), width: await width() }

  await showPane(page, 'Sessions')
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('radio', { name: 'Dark' }).click()
  await page.getByRole('radio', { name: /Nord/ }).click()
  await page.getByRole('radio', { name: 'Color', exact: true }).click()
  await page.getByRole('radio', { name: 'Large' }).click()
  await page.getByRole('checkbox', { name: 'Wide transcript' }).check()
  await page.keyboard.press('Escape')
  await expect(page.locator('.avatar-claude svg:visible').first()).toBeVisible()
  expect(await paper()).toBe('rgb(46, 52, 64)')
  await showPane(page, 'Chat')
  expect(await size()).toBeGreaterThan(before.size)
  if (test.info().project.name === 'desktop') expect(await width()).toBeGreaterThan(before.width)

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('html')).toHaveAttribute('data-agent-icons', 'color')
  expect(await paper()).toBe('rgb(46, 52, 64)')
})
