import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { showPane } from './pane'

test('a title emoji can be previewed, replaced, saved and removed', async ({ page }, info) => {
  const res = await page.request.post('/api/sessions', {
    headers: { Authorization: `Bearer ${token}` }, data: { agent: 'claude', cwd: '/tmp' },
  })
  const { id } = await res.json() as { id: string }
  await page.request.post(`/api/sessions/${id}/title`, {
    headers: { Authorization: `Bearer ${token}` }, data: { title: 'Release notes' },
  })
  await page.goto(`/s/${id}?token=${token}`)
  await page.getByRole('button', { name: 'Rename session', exact: true }).click()
  await page.getByRole('button', { name: 'Choose title emoji' }).click()
  const picker = page.getByRole('dialog', { name: 'Title emoji', exact: true })
  await expect(picker).toBeVisible()
  if (info.project.name === 'mobile') await expect(page.locator('html')).not.toHaveAttribute('data-typing', 'chat')
  // Showing the phone's chrome again moves the trigger without a resize.
  // On a tall screen the palette must follow it and leave the name visible.
  await expect.poll(async () => {
    const field = await page.getByRole('textbox', { name: 'Session name' }).boundingBox()
    const palette = await picker.boundingBox()
    return palette!.y >= field!.y + field!.height
  }).toBe(true)
  await page.screenshot({ path: info.outputPath('title-emoji.png') })
  await picker.getByText('One emoji at the start of your name.').click()
  await expect(picker).toBeVisible()
  const box = await picker.boundingBox()
  const viewport = page.viewportSize()!
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)
  await picker.getByRole('searchbox').fill('ракета')
  await picker.getByRole('button', { name: '🚀 Rocket' }).click()
  await expect(page.getByRole('textbox', { name: 'Session name' })).toHaveValue('🚀 Release notes')
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(page.getByRole('heading', { name: '🚀 Release notes', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: '🚀 Release notes', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Rename session', exact: true }).click()
  await page.getByRole('button', { name: 'Change title emoji' }).click()
  await picker.getByRole('button', { name: '🐛 Bug' }).click()
  await page.getByRole('textbox', { name: 'Session name' }).press('Escape')
  await expect(page.getByRole('heading', { name: '🚀 Release notes', exact: true })).toBeVisible()

  await showPane(page, 'Sessions')
  await page.getByRole('button', { name: 'Actions for 🚀 Release notes', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  await page.getByRole('button', { name: 'Change title emoji' }).click()
  await picker.getByRole('button', { name: 'Remove emoji' }).click()
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(page.locator('.session-title', { hasText: 'Release notes' }).first()).toHaveText('Release notes')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
