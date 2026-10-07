import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'

const headers = { Authorization: `Bearer ${token}` }

// The composer keeps its height when a turn starts and ends: Stop and the
// steer hint join its row without wrapping it onto a second one.
for (const [width, dock] of [
  [1440, true],
  [1280, true],
  [1280, false],
  [1100, true],
  [1600, true],
] as const) {
  test(`the composer keeps its height across a turn at ${width}px, dock ${dock ? 'open' : 'closed'}`, async ({ page, isMobile }) => {
    test.skip(isMobile, 'a desktop width')
    const r = await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd: '/tmp' } })
    const { id } = (await r.json()) as { id: string }
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/s/${id}?token=${token}`)
    const bar = page.getByRole('toolbar', { name: 'Dock' })
    const changes = bar.getByRole('button', { name: 'Changes' })
    if (dock !== ((await changes.getAttribute('aria-pressed')) === 'true')) await changes.click()
    const composer = page.locator('form.composer')
    await expect(composer).toBeVisible()
    const idle = await composer.evaluate((el) => el.getBoundingClientRect().height)

    await page.getByLabel('Message').fill('please permission steady')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(composer.getByRole('button', { name: 'Stop' })).toBeVisible()
    await expect(composer.getByRole('button', { name: 'Steer' })).toBeVisible()
    expect(await composer.evaluate((el) => el.getBoundingClientRect().height), 'running').toBe(idle)

    await page.getByRole('button', { name: 'Allow', exact: true }).click()
    await expect(composer.getByRole('button', { name: 'Stop' })).toHaveCount(0)
    expect(await composer.evaluate((el) => el.getBoundingClientRect().height), 'idle again').toBe(idle)
    // one row: the actions sit beside the text, not under it
    expect(idle).toBeLessThan(60)
  })
}
