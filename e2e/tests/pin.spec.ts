import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { showPane } from './pane'

test('pins above projects, persists after reload, syncs another tab and unpins', async ({ page, context, request }, info) => {
  const name = `Pinned ${info.project.name} ${Date.now()}`
  const response = await request.post('/api/sessions', {
    headers: { Authorization: `Bearer ${token}` },
    data: { agent: 'claude', cwd: '/tmp' },
  })
  expect(response.ok()).toBeTruthy()
  const session = await response.json()
  await request.post(`/api/sessions/${session.id}/title`, {
    headers: { Authorization: `Bearer ${token}` }, data: { title: name },
  })
  await page.goto(`/s/${session.id}?token=${token}`)
  await showPane(page, 'Sessions')
  const other = await context.newPage()
  await other.goto('/')
  await showPane(other, 'Sessions')
  await page.getByRole('button', { name: `Actions for ${name}` }).click()
  await page.getByRole('menuitem', { name: 'Pin', exact: true }).click()
  const pinned = page.getByRole('region', { name: 'Pinned sessions' })
  await expect(pinned.getByText(name, { exact: true })).toBeVisible()
  if (info.project.name === 'desktop') await expect(pinned.locator(`button.session[data-session="${session.id}"]`)).toBeFocused()
  await expect(other.getByRole('region', { name: 'Pinned sessions' }).getByText(name, { exact: true })).toBeVisible()
  await expect(page.locator('.groups > section').first()).toHaveAttribute('aria-label', 'Pinned sessions')
  await page.reload()
  await showPane(page, 'Sessions')
  await expect(pinned.getByText(name, { exact: true })).toBeVisible()
  await pinned.getByRole('button', { name: `Actions for ${name}` }).click()
  await page.getByRole('menuitem', { name: 'Unpin', exact: true }).click()
  await expect(pinned.getByText(name, { exact: true })).toHaveCount(0)
  await expect(page.locator('.groups').getByText(name, { exact: true })).toBeVisible()
  if (info.project.name === 'desktop') await expect(page.locator(`button.session[data-session="${session.id}"]`)).toBeFocused()
  await expect(other.getByRole('region', { name: 'Pinned sessions' }).getByText(name, { exact: true })).toHaveCount(0)
})
