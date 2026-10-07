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
  await page.getByLabel('Message').fill(`and now here ${proj}`)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText(`echo: and now here ${proj}`)).toBeVisible()
})

// Opened at the bottom of a short sidebar, History brings what it loaded
// into view, not only its header.
test('opening History shows the conversations it loaded', async ({ page, isMobile }) => {
  if (!isMobile) await page.setViewportSize({ width: 1280, height: 700 })
  // Enough sessions to put History at the sidebar's bottom edge.
  const headers = { Authorization: `Bearer ${token}` }
  for (let i = 0; i < 14; i++) await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd: '/tmp' } })
  await page.goto(`/?token=${token}`)
  const bar = page.getByRole('navigation', { name: 'Views' })
  if (await bar.isVisible()) await bar.getByRole('button', { name: /^Sessions/ }).click()
  await page.locator('.history:not(.archived) > summary').click()
  const first = page.locator('.history:not(.archived) .history-list li').first()
  await expect(first).toBeVisible()
  await expect(first).toBeInViewport()
  await expect(page.locator('.history:not(.archived) > summary')).toBeInViewport()
})
