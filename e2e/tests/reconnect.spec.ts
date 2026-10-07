import { expect, test, type WebSocketRoute } from '@playwright/test'
import { token } from '../playwright.config'
import { showPane } from './pane'

// Accounts that couldn't be checked while go-chamber was out of reach are
// checked again once live updates are back, without a tap on Retry.
test('the accounts are checked again when live updates come back', async ({ page }) => {
  let down = true
  await page.routeWebSocket(/\/api\/ws$/, (ws) => (down ? void ws.close() : void ws.connectToServer()))
  await page.route('**/api/account?*', (route) => (down ? route.abort() : route.continue()))
  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  const failed = page.locator('.accounts').getByRole('alert')
  await expect(failed).toContainText("Couldn't reach the accounts")
  down = false
  await expect(failed).toHaveCount(0, { timeout: 15_000 })
  await expect(page.locator('.accounts')).toContainText('Claude')
})

// A server restart, as the page sees it: the live socket drops, health and
// new sockets fail for a while, then both answer again.
test('the live socket comes back as soon as the server does, not after the backoff', async ({ page, isMobile }) => {
  let down = false
  let attempts = 0
  const live: WebSocketRoute[] = []
  await page.routeWebSocket(/\/api\/ws$/, (ws) => {
    if (down) {
      attempts++
      void ws.close()
      return
    }
    live.push(ws)
    ws.connectToServer()
  })
  await page.route('**/api/health', (route) => (down ? route.abort() : route.continue()))
  await page.goto(`/?token=${token}`)
  await expect.poll(() => live.length).toBe(1)

  down = true
  await live[0]!.close()
  // Failed attempts at 1s, 3s and 7s grow the next wait to 8s.
  await expect.poll(() => attempts, { timeout: 15_000 }).toBeGreaterThanOrEqual(3)

  down = false
  await expect.poll(() => live.length, { timeout: 3500 }).toBe(2)
  if (!isMobile) await expect(page.getByRole('status', { name: 'online' })).toBeVisible()
})
