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
  await page.goto(`/?token=${token}`)
  const toggle = page.getByRole('button', { name: 'Sounds' })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => page.evaluate(() => (window as unknown as { tones: number }).tones)).toBe(1)

  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await page.getByLabel('Message').fill(`sound ${info.project.name} ${Date.now()}: please permission`)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.request-title', { hasText: 'Run command' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as unknown as { tones: number }).tones)).toBeGreaterThanOrEqual(3)

  await page.reload()
  await expect(page.getByRole('button', { name: 'Sounds' })).toHaveAttribute('aria-pressed', 'true')
})
