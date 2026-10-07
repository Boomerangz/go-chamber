import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'

test('overview works without PiP, handles background work and returns from chat', async ({ page, context }, info) => {
  await page.goto(`/overview?token=${token}`)
  const overview = page.getByRole('region', { name: 'Overview', exact: true })
  await expect(overview.getByRole('heading', { name: 'Overview' })).toBeVisible()
  await page.reload()
  await expect(overview).toBeVisible()
  const created = await context.request.post('/api/sessions', { data: { agent: 'claude', cwd: '/tmp' } })
  expect(created.ok()).toBe(true)
  const { id } = await created.json() as { id: string }
  const sent = await context.request.post(`/api/sessions/${id}/messages`, { data: { text: 'overview task: please permission' } })
  expect(sent.ok()).toBe(true)
  const activity = overview.locator('.attention-session').filter({ hasText: 'overview task:' })
  await expect(activity.getByLabel('Task elapsed')).toHaveText(/^\d+:\d\d$/)
  await overview.getByRole('listitem').filter({ hasText: 'overview task:' }).getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(activity.locator('.attention-result')).toContainText('approved: run')
  expect(await page.locator('body').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('overview.png') })
  await activity.getByRole('button', { name: 'Open result' }).click()
  await expect(page.getByLabel('Message')).toBeVisible()
  await page.goBack()
  await expect(overview).toBeVisible()
  // Opening the result was a look: it is no longer news.
  await expect(activity).toHaveCount(0)
  if (info.project.name === 'mobile') {
    await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Sessions' }).click()
    await expect(overview).toHaveCount(0)
    await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Overview' }).click()
    await expect(overview).toBeVisible()
  }
})
