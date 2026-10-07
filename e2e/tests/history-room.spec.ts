import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'

// Opening History at the foot of a long session list brings it into view
// without pushing the sessions out of sight: they keep about 40% of the
// sidebar, and the sidebar scrolls as a whole meanwhile.
for (const size of [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
]) {
  test(`History leaves the sessions room at ${size.width}x${size.height}`, async ({ page, isMobile }, info) => {
    test.skip(isMobile, 'laptop sizes')
    await page.setViewportSize(size)
    const headers = { Authorization: `Bearer ${token}` }
    for (let i = 0; i < 16; i++) await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd: '/tmp' } })
    await page.goto(`/?token=${token}`)
    const summary = page.locator('.history:not(.archived) > summary')
    await summary.click()
    const first = page.locator('.history:not(.archived) .history-list li').first()
    await expect(first).toBeInViewport()
    await expect(summary).toBeInViewport()
    // The reveal has settled once the sidebar stops scrolling.
    const sidebar = page.locator('aside.sidebar')
    await expect.poll(async () => {
      const a = await sidebar.evaluate((e) => e.scrollTop)
      await page.waitForTimeout(100)
      return a === (await sidebar.evaluate((e) => e.scrollTop))
    }).toBe(true)
    const shown = await page.evaluate(() => {
      const side = document.querySelector('aside.sidebar')!.getBoundingClientRect()
      const search = document.querySelector('.sidebar-body > .session-search')!.getBoundingClientRect()
      const groups = document.querySelector('.groups')!.getBoundingClientRect()
      const visible = Math.min(groups.bottom, side.bottom) - Math.max(groups.top, search.bottom)
      return { visible, side: side.height }
    })
    expect(shown.visible).toBeGreaterThan(shown.side * 0.3)
    await page.screenshot({ path: info.outputPath(`history-${size.width}x${size.height}.png`) })
  })
}
