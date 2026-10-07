import { expect, test, type Page } from '@playwright/test'
import { token } from '../playwright.config'

// A phone's top bar: the three modes, with their counts, and the link state
// share one 44px row. Every mode reads whole and stays in reach; nothing
// draws over another.

const headers = { Authorization: `Bearer ${token}` }

// clashes lists what is wrong with the bar: a mode cut or scrolled, a mode
// under the health status, the bar wider than the window.
function clashes(page: Page) {
  return page.evaluate(() => {
    const out: string[] = []
    const w = window.innerWidth
    if (document.documentElement.scrollWidth > w) out.push(`page ${document.documentElement.scrollWidth}`)
    const sw = document.querySelector<HTMLElement>('.mode-switch')!
    if (sw.scrollWidth > sw.clientWidth + 0.5) out.push(`modes scroll ${sw.scrollWidth}/${sw.clientWidth}`)
    const health = document.querySelector('.topbar-end > .health')!.getBoundingClientRect()
    for (const b of document.querySelectorAll<HTMLElement>('.mode-switch [role="radio"]')) {
      const r = b.getBoundingClientRect()
      const text = document.createRange()
      text.selectNodeContents(b)
      const t = text.getBoundingClientRect()
      const name = b.textContent
      if (t.right > r.right + 0.5 || t.left < r.left - 0.5) out.push(`${name} cut`)
      if (r.right > sw.getBoundingClientRect().right + 0.5) out.push(`${name} past the modes`)
      if (r.right > health.left + 0.5 && r.left < health.right - 0.5) out.push(`${name} under the health status`)
      if (r.right > w + 0.5) out.push(`${name} off screen`)
    }
    return out
  })
}

test('terminal mode keeps every mode whole on a narrow phone, counts and all', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'RTCPeerConnection', { value: undefined }))
  // something waits for the owner (the Agents tab's count) and a shell runs
  // (the Terminal tab's)
  const made = await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd: '/tmp' } })
  const { id } = (await made.json()) as { id: string }
  await page.request.post(`/api/sessions/${id}/messages`, { headers, data: { text: 'please permission' } })
  const term = await page.request.post('/api/terminals', { headers, data: { cwd: '/tmp', cols: 80, rows: 24 } })
  expect(term.ok()).toBe(true)
  const { id: termId } = (await term.json()) as { id: string }
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto(`/?token=${token}`)
  await page.getByRole('radio', { name: /^Terminal/ }).click()
  const modes = page.getByRole('radiogroup', { name: 'Mode' })
  await expect(modes.locator('.badge')).toBeVisible()
  await expect(modes.locator('.count')).toBeVisible()
  for (const width of [360, 361, 375, 390, 400, 412, 430]) {
    await page.setViewportSize({ width, height: 800 })
    await expect.poll(() => clashes(page), { message: `${width}` }).toEqual([])
  }
  await page.request.delete(`/api/terminals/${termId}`, { headers })
})

test('while live updates are down, the Diagnostics tab stays in reach on a phone', async ({ page }) => {
  let drop = () => {}
  await page.routeWebSocket('**/api/ws', (ws) => {
    const server = ws.connectToServer()
    drop = () => {
      void server.close()
      void ws.close()
    }
  })
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto(`/?token=${token}`)
  await expect(page.getByRole('status', { name: 'online' })).toBeVisible()
  // keep it down: every retry is refused at once
  await page.unrouteAll()
  await page.routeWebSocket('**/api/ws', (ws) => void ws.close())
  drop()
  const health = page.locator('.topbar-end > .health-reconnecting')
  await expect(health).toBeVisible()
  // the mark says it, its words are its name
  await expect(health).toHaveAccessibleName(/reconnecting/)
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 800 })
    await expect.poll(() => clashes(page), { message: `${width}` }).toEqual([])
  }
  await page.getByRole('radio', { name: /^Diagnostics/ }).click()
  await expect(page.getByRole('radio', { name: /^Diagnostics/ })).toHaveAttribute('aria-checked', 'true')
})
