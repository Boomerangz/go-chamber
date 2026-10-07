import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'

const headers = { Authorization: `Bearer ${token}` }

// Overview opens on its first waiting row, so the a/s/d its buttons show
// answer at once, as a request card in the chat does.
test('Overview opens on the first waiting row, whose keys answer it', async ({ page, isMobile }, info) => {
  const tag = `overview keys ${info.project.name} ${Date.now().toString(36)}`
  const r = await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd: '/tmp' } })
  const { id } = (await r.json()) as { id: string }
  await page.request.post(`/api/sessions/${id}/messages`, { headers, data: { text: `${tag}: please permission` } })
  await page.goto(`/s/${id}?token=${token}`)
  await expect(page.locator('.request-title', { hasText: 'Run command' })).toBeVisible()

  if (isMobile) await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Overview' }).click()
  else await page.getByRole('button', { name: 'Overview', exact: true }).click()
  const overview = page.getByRole('region', { name: 'Overview', exact: true })
  const line = overview.getByRole('listitem').filter({ hasText: tag })
  await expect(line).toBeVisible()
  // The first waiting row has focus: a row, never a text field.
  const first = overview.locator('.attention-inbox .tray-row').first()
  await expect(first).toBeFocused()
  if (isMobile) return
  // Other specs may leave requests waiting; answer this one from its own row.
  await line.locator('.tray-row').focus()
  await page.keyboard.press('a')
  await expect(line).toHaveCount(0)
  await expect(overview.locator('.attention-session', { hasText: tag }).locator('.attention-result')).toContainText('approved: run')
})
