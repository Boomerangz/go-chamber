import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'

test('opens a conversation started in a terminal and continues it', async ({ page }, info) => {
  const proj = info.project.name
  await page.goto(`/?token=${token}`)
  const bar = page.getByRole('navigation', { name: 'Views' })
  if (await bar.isVisible()) await bar.getByRole('button', { name: /^Sessions/ }).click()

  await page.locator('.history:not(.archived) > summary').click()
  await expect(page.getByText('Tidy the README')).toBeVisible() // Codex's recorded thread
  await page.getByRole('button', { name: new RegExp(`Started in a terminal \\(${proj}\\)`) }).click()

  await expect(page.getByText(`answered in the terminal ${proj}`)).toBeVisible()
  await page.getByLabel('message').fill(`and now here ${proj}`)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText(`echo: and now here ${proj}`)).toBeVisible()
})
