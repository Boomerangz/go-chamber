import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession } from './pane'

test('floating panel approves a live request and can be reopened', async ({ page, context }, info) => {
  test.skip(info.project.name !== 'desktop', 'Document PiP is a desktop feature')
  await page.goto(`/?token=${token}`)
  const open = page.getByRole('button', { name: 'Open floating panel' })
  await expect(open).toBeEnabled()
  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await page.getByLabel('Message').fill('pip prototype: please permission')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.request-title', { hasText: 'Run command' })).toBeVisible()
  const childOpened = context.waitForEvent('page')
  await open.click()
  const child = await childOpened
  // The owner works elsewhere: a chat in view would see the result itself.
  await page.getByRole('radio', { name: 'Terminal' }).click()
  // Headless Chromium inherits the context viewport instead of native PiP bounds.
  await child.setViewportSize({ width: 420, height: 560 })
  const request = child.getByRole('listitem').filter({ hasText: 'pip prototype: please permission' })
  await expect(request).toBeVisible()
  const activity = child.locator('.attention-session').filter({ hasText: 'pip prototype: please permission' })
  await expect(activity.getByLabel('Task elapsed')).toHaveText(/^\d+:\d\d$/)
  await expect(activity.locator('.attention-waiting')).toContainText('Waiting for you ·')
  expect(await child.locator('body').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await child.screenshot({ path: info.outputPath('floating-panel.png') })
  await request.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(request).toHaveCount(0)
  // The inbox is every session's: other specs' requests may still wait
  // there, so this session's own line says it no longer waits.
  await expect(activity.locator('.attention-waiting')).toHaveCount(0)
  await expect(activity.locator('.attention-outcome')).toHaveText('Done')
  // Cards are divided between them: the last one draws no rule over the footer's.
  await expect(child.locator('.attention-session').last()).toHaveCSS('border-bottom-width', '0px')
  await expect(activity.locator('.attention-result')).toContainText('approved: run')
  const duration = await activity.getByLabel('Task elapsed').textContent()
  await expect(child.locator('body')).toHaveCSS('overflow', 'auto')
  await child.close()
  await expect(open).toHaveAttribute('aria-pressed', 'false')
  const reopened = context.waitForEvent('page')
  await open.click()
  const again = await reopened
  const result = again.locator('.attention-session').filter({ hasText: 'pip prototype: please permission' })
  await expect(result.getByLabel('Task elapsed')).toHaveText(duration!)
  await result.getByRole('button', { name: 'Dismiss result' }).click()
  await expect(result).toHaveCount(0)
  await again.close()
})

test('floating panel receives a background session without selecting its chat', async ({ page, context }, info) => {
  test.skip(info.project.name !== 'desktop', 'Document PiP is a desktop feature')
  await page.goto(`/?token=${token}`)
  const opened = context.waitForEvent('page')
  await page.getByRole('button', { name: 'Open floating panel' }).click()
  const child = await opened
  await child.setViewportSize({ width: 420, height: 560 })
  const created = await context.request.post('/api/sessions', { data: { agent: 'claude', cwd: '/tmp' } })
  expect(created.ok()).toBe(true)
  const { id } = await created.json() as { id: string }
  const sent = await context.request.post(`/api/sessions/${id}/messages`, { data: { text: 'background clock: please permission' } })
  expect(sent.ok()).toBe(true)
  const activity = child.locator('.attention-session').filter({ hasText: 'background clock:' })
  await expect(activity.getByLabel('Task elapsed')).toHaveText(/^\d+:\d\d$/)
  const initial = await activity.getByLabel('Task elapsed').textContent()
  await expect(activity.getByLabel('Task elapsed')).not.toHaveText(initial!)
  await child.getByRole('listitem').filter({ hasText: 'background clock:' }).getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(activity.locator('.attention-result')).toContainText('approved: run')
  await expect(page.getByLabel('Message')).not.toBeVisible()
  await child.screenshot({ path: info.outputPath('background-result.png') })
  await child.close()
})
