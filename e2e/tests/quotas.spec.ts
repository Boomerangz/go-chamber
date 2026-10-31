import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

test('Claude weekly usage expires and a fresh report replaces it', async ({ page }) => {
  // This scenario owns its quota reports. Other tests' turns on the shared
  // backend must not replace its mocked weekly window through live events.
  await page.routeWebSocket('**/api/ws', (ws) => {
    const server = ws.connectToServer()
    server.onMessage((message) => {
      if (!String(message).includes('"type":"quota"')) ws.send(message)
    })
    ws.onMessage((message) => server.send(message))
  })
  const now = new Date()
  await page.clock.install({ time: now })
  let usage = 99
  let reset = new Date(now.getTime() + 30_000).toISOString()
  await page.route('**/api/quotas', (route) => route.fulfill({ json: [{
    agent: 'claude', windows: [{ name: 'seven_day', usedPct: usage, resetsAt: reset }],
  }] }))
  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  const summary = page.locator('.quotas-details summary')
  await expect(summary).toContainText('99%')
  await page.clock.fastForward(60_000)
  await expect(summary).toContainText('awaiting update')
  await expect(page.locator('.quotas-details')).not.toContainText('99%')
  await expect(page.locator('.quotas-details .fill')).toHaveCount(0)
  await summary.click()
  await expect(page.getByLabel('Quotas', { exact: true })).toContainText('reset just now · awaiting update')

  usage = 2
  reset = new Date(now.getTime() + 7 * 86_400_000).toISOString()
  await page.reload()
  await showPane(page, 'Sessions')
  await expect(summary).toContainText('2%')
  await expect(summary).not.toContainText('awaiting update')
})

test('shows codex quota bars and session usage', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByRole('radio', { name: 'Codex' }).click()
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()

  await page.getByLabel('Message').fill('hello')
  await page.getByRole('button', { name: 'Send', exact: true }).click()

  await expect(page.getByLabel('Session usage')).toBeVisible()
  await showPane(page, 'Sessions')
  const quotas = page.getByLabel('Quotas', { exact: true })
  await expect(quotas).toContainText('5h window')
  await expect(quotas).toContainText('25%')
  await expect(quotas).toContainText('7d window')
})

test('shows claude quota bars', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()

  await page.getByLabel('Message').fill('hi')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.item.assistant').first()).toBeVisible()
  await showPane(page, 'Sessions')
  await expect(page.getByLabel('Quotas', { exact: true })).toContainText('5h window')
})

// The folded quota line names each agent by its letter box, so the window
// and its reset read whole at the narrow sidebar widths too.
test('the folded quota line reads its reset whole', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the phone sidebar is the full width')
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await page.getByLabel('Message').fill('hi')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.item.assistant').first()).toBeVisible()
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 })
    const when = page.locator('.quota-mini .quota-when').first()
    await expect(when).toBeVisible()
    await expect.poll(() => when.evaluate((el) => el.scrollWidth - el.clientWidth), { message: `${width}` }).toBeLessThanOrEqual(1)
  }
})
