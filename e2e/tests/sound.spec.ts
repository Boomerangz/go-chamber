import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession } from './pane'

test('chimes when the agent asks for a decision once sounds are on', async ({ page }, info) => {
  // count synthesized tones instead of listening for them
  await page.addInitScript(() => {
    const w = window as unknown as { tones: number }
    w.tones = 0
    const create = AudioContext.prototype.createOscillator
    AudioContext.prototype.createOscillator = function () {
      w.tones++
      return create.call(this)
    }
  })
  // Any session asking or finishing chimes, and one server runs every spec:
  // the page hears only this test's session ask and finish, so the tones
  // counted are its own.
  let mine: string | null = null
  await page.routeWebSocket('**/api/ws', (ws) => {
    const server = ws.connectToServer()
    server.onMessage((m) => {
      const ev = typeof m === 'string' ? (JSON.parse(m) as { type?: string; sessionId?: string }) : {}
      if ((ev.type === 'request.opened' || ev.type === 'turn.ended') && ev.sessionId !== mine) return
      ws.send(m)
    })
  })
  await page.goto(`/?token=${token}`)
  const toggle = page.getByRole('button', { name: 'Sounds' })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => page.evaluate(() => (window as unknown as { tones: number }).tones)).toBe(1)
  // chimes within 600ms of each other make one sound: let the toggle's pass
  await page.waitForTimeout(700)

  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page).toHaveURL(/\/s\/[^/?]+/)
  mine = new URL(page.url()).pathname.split('/s/')[1]!
  await page.getByLabel('Message').fill(`sound ${info.project.name} ${Date.now()}: please permission`)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.request-title', { hasText: 'Run command' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as unknown as { tones: number }).tones)).toBeGreaterThanOrEqual(3)

  await page.reload()
  await expect(page.getByRole('button', { name: 'Sounds' })).toHaveAttribute('aria-pressed', 'true')
})
